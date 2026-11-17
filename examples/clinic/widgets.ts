import { BaseWidget, type Principal, z } from '../../src/index.js';

// --- Esquemas Zod ---
export const EmptySchema = z.object({});

export const SearchDoctorsSchema = z.object({
  specialty: z
    .string()
    .optional()
    .describe('Especialidad médica o nombre del doctor (ej. Cardiología, Pediatría).'),
});

export const DoctorDetailSchema = z.object({
  doctorId: z
    .string()
    .min(1)
    .describe('ID exacto del médico listado previamente (ej. doc-101).'),
});

export const StartBookingSchema = z.object({
  doctorId: z.string().min(1).describe('ID del médico con quien desea agendar.'),
  slot: z
    .string()
    .optional()
    .describe('Horario deseado si el usuario lo indicó (ej. 2026-11-20 10:00).'),
});

/**
 * Esquema para invocación directa desde el LLM cuando el usuario indica especialidad y horario
 * en lenguaje natural, permitiendo que `StartBookingWidget.execute()` resuelva el `doctorId` en el backend.
 */
export const DirectBookingBySpecialtySchema = z.object({
  specialty: z.string().min(2).describe('Especialidad solicitada (ej. Cardiología).'),
  slot: z.string().optional().describe('Horario solicitado si lo mencionó.'),
});

export const RegisterPatientSchema = z.object({
  doctorId: z.string().optional(),
  slot: z.string().optional(),
});

export const ConfirmBookingSchema = z.object({
  doctorId: z.string().min(1),
  patientId: z.string().min(1),
  slot: z.string().min(1, 'Debe seleccionar un horario para confirmar la cita'),
  dependentName: z.string().optional(),
});

export const BookingTicketSchema = z.object({
  appointmentId: z.string().min(1),
  doctorId: z.string().min(1),
  patientId: z.string().min(1),
  slot: z.string().min(1),
});

// --- Datos simulados de backend ---
const DOCTORS_DB = [
  { doctorId: 'doc-101', name: 'Dra. Elena Gómez', specialty: 'Cardiología' },
  { doctorId: 'doc-102', name: 'Dr. Marcos Silva', specialty: 'Pediatría' },
];

// --- Clases de Widgets ---

export class IdleWidget extends BaseWidget<z.infer<typeof EmptySchema>, {}, 'IDLE'> {
  readonly component = 'IDLE' as const;
  readonly dataSource = 'client' as const;
  readonly schema = EmptySchema;
}

export class SearchDoctorsWidget extends BaseWidget<
  z.infer<typeof SearchDoctorsSchema>,
  {
    VIEW_DOCTOR: { doctorId: string };
    BOOK_WITH_DOCTOR: { doctorId: string; slot?: string };
  },
  'DOCTOR_LIST',
  { doctors: Array<{ doctorId: string; name: string; specialty: string }> }
> {
  readonly component = 'DOCTOR_LIST' as const;
  readonly dataSource = 'backend' as const;
  readonly schema = SearchDoctorsSchema;

  async execute(input: z.infer<typeof SearchDoctorsSchema>) {
    const q = input.specialty?.toLowerCase().trim();
    const doctors = !q
      ? [...DOCTORS_DB]
      : DOCTORS_DB.filter(
          (d) =>
            d.specialty.toLowerCase().includes(q) ||
            d.name.toLowerCase().includes(q),
        );
    return { doctors };
  }
}

export class DoctorDetailWidget extends BaseWidget<
  z.infer<typeof DoctorDetailSchema>,
  { BOOK_WITH_DOCTOR: { doctorId: string; slot?: string } },
  'DOCTOR_PROFILE',
  { doctorId: string; name: string; availableSlots: string[] }
> {
  readonly component = 'DOCTOR_PROFILE' as const;
  readonly dataSource = 'backend' as const;
  readonly schema = DoctorDetailSchema;

  async execute(input: z.infer<typeof DoctorDetailSchema>) {
    const doc = DOCTORS_DB.find((d) => d.doctorId === input.doctorId);
    return {
      doctorId: input.doctorId,
      name: doc?.name ?? 'Médico',
      availableSlots: ['2026-11-20 10:00', '2026-11-20 11:30'],
    };
  }
}

export class StartBookingWidget extends BaseWidget<
  z.infer<typeof StartBookingSchema>,
  {
    SELECT_PATIENT: { patientId: string; slot: string };
    NEW_DEPENDENT_PATIENT: { slot?: string };
  },
  'PATIENT_SELECTOR',
  {
    doctorId: string;
    patients: Array<{ patientId: string; fullName: string }>;
  }
> {
  readonly component = 'PATIENT_SELECTOR' as const;
  readonly dataSource = 'backend' as const;
  readonly schema = StartBookingSchema;

  async execute(
    input: { doctorId?: string; specialty?: string; slot?: string },
    principal: Principal,
  ) {
    // Si fue invocado vía llmTool.schema con `specialty`, el backend resuelve el `doctorId`
    let resolvedDoctorId = input.doctorId;
    if (!resolvedDoctorId && input.specialty) {
      const q = input.specialty.toLowerCase();
      const found = DOCTORS_DB.find((d) => d.specialty.toLowerCase().includes(q));
      resolvedDoctorId = found?.doctorId ?? DOCTORS_DB[0].doctorId;
    }

    return {
      doctorId: resolvedDoctorId!,
      // El backend devuelve solo los pacientes que pertenecen a `principal.userId`
      patients: [
        {
          patientId: `pat-${principal.userId}`,
          fullName: 'Titular de la Cuenta',
        },
      ],
    };
  }
}

export class RegisterPatientWidget extends BaseWidget<
  z.infer<typeof RegisterPatientSchema>,
  {
    // El cliente envía los datos del formulario, NUNCA un `patientId` arbitrario
    PATIENT_REGISTERED: { dependentName: string; slot?: string };
  },
  'PATIENT_FORM'
> {
  readonly component = 'PATIENT_FORM' as const;
  readonly dataSource = 'client' as const;
  readonly schema = RegisterPatientSchema;
}

export class ConfirmBookingWidget extends BaseWidget<
  z.infer<typeof ConfirmBookingSchema>,
  {
    // El cliente confirma sin inventar el `appointmentId`
    CONFIRM_APPOINTMENT: {};
  },
  'BOOKING_CHECKOUT',
  { patientId: string; summaryText: string }
> {
  readonly component = 'BOOKING_CHECKOUT' as const;
  readonly dataSource = 'backend' as const;
  readonly schema = ConfirmBookingSchema;

  async execute(
    input: {
      doctorId: string;
      patientId?: string;
      dependentName?: string;
      slot?: string;
    },
    principal: Principal,
  ) {
    // Si viene del alta de carga familiar (`dependentName`), el backend crea el `patientId`
    // asociado al `principal.userId` y lo emite hacia la allowlist de la sesión.
    const resolvedPatientId =
      input.patientId ?? `pat-${principal.userId}-dep-01`;

    return {
      patientId: resolvedPatientId,
      summaryText: `Reserva con médico ${input.doctorId} para paciente ${resolvedPatientId} (${input.dependentName ?? 'Titular'}) a las ${input.slot}`,
    };
  }
}

export class BookingTicketWidget extends BaseWidget<
  z.infer<typeof BookingTicketSchema>,
  {},
  'BOOKING_RECEIPT',
  { appointmentId: string; status: 'CONFIRMED'; slot: string }
> {
  readonly component = 'BOOKING_RECEIPT' as const;
  readonly dataSource = 'backend' as const;
  readonly schema = BookingTicketSchema;

  async execute(
    input: { doctorId: string; patientId: string; slot: string },
    principal: Principal,
  ) {
    // El backend genera el `appointmentId` al persistir la cita para `principal.userId`
    const generatedAppointmentId = `apt-${principal.userId}-9001`;
    return {
      appointmentId: generatedAppointmentId,
      status: 'CONFIRMED' as const,
      slot: input.slot,
    };
  }
}

export class UnknownWidget extends BaseWidget<
  z.infer<typeof EmptySchema>,
  {},
  'UNKNOWN'
> {
  readonly component = 'UNKNOWN' as const;
  readonly dataSource = 'client' as const;
  readonly schema = EmptySchema;
}
