import {
  Chat,
  type ChatMemory,
  InMemoryChatMemory,
  type LLMAdapter,
  OpenAIAdapter,
  type Principal,
} from '../../src/index.js';
import {
  BookingTicketWidget,
  ConfirmBookingWidget,
  DirectBookingBySpecialtySchema,
  DoctorDetailWidget,
  IdleWidget,
  RegisterPatientWidget,
  SearchDoctorsWidget,
  StartBookingWidget,
  UnknownWidget,
} from './widgets.js';

export const createClinicChat = (
  chatId: string,
  principal: Principal,
  options?: {
    llm?: LLMAdapter;
    memory?: ChatMemory;
  },
) =>
  new Chat({
    chatId,
    principal,
    systemPrompt: [
      'Eres el asistente virtual de Clínica Salud Digital.',
      'Elige exactamente una herramienta según la intención del paciente.',
      'Si la consulta no corresponde a las herramientas médicas disponibles, usa UNKNOWN.',
    ].join('\n'),
    llm:
      options?.llm ??
      new OpenAIAdapter({
        apiKey: process.env.OPENAI_API_KEY ?? 'sk-demo',
        model: 'gpt-4o-mini',
      }),
    memory: options?.memory ?? new InMemoryChatMemory({ maxTurns: 6 }),
    initialState: 'IDLE',

    states: {
      IDLE: {
        widget: new IdleWidget(),
        blocksInput: false,
        cancel: null,
      },

      SEARCH_DOCTORS: {
        widget: new SearchDoctorsWidget(),
        llmTool: {
          description:
            'Busca médicos por especialidad o nombre. Si no se indica filtro, lista todos.',
        },
        summary: (p, data) => {
          const list = data.doctors
            .map((d) => `${d.doctorId} (${d.name} - ${d.specialty})`)
            .join(', ');
          return `buscó médicos${p.specialty ? ` de "${p.specialty}"` : ''} -> resultados: [${list}]`;
        },
        blocksInput: false,
        cancel: null,
        on: {
          VIEW_DOCTOR: { to: 'DOCTOR_DETAIL' },
          BOOK_WITH_DOCTOR: { to: 'START_BOOKING' },
        },
      },

      DOCTOR_DETAIL: {
        widget: new DoctorDetailWidget(),
        llmTool: {
          description:
            'Muestra el perfil y horarios disponibles de un médico listado previamente.',
        },
        summary: (p, data) => `revisó horarios de ${data.name} (${p.doctorId})`,
        blocksInput: false,
        cancel: 'IDLE',
        idFields: ['doctorId'],
        on: {
          BOOK_WITH_DOCTOR: { to: 'START_BOOKING', keep: ['doctorId'] },
        },
      },

      START_BOOKING: {
        widget: new StartBookingWidget(),
        // Demostración de `llmTool.schema`: el LLM puede invocar START_BOOKING con `{ specialty, slot }`
        // en lenguaje natural y `StartBookingWidget.execute()` resuelve el `doctorId` en el backend.
        llmTool: {
          description:
            'Inicia el agendamiento de una consulta médica indicando la especialidad y opcionalmente el horario.',
          schema: DirectBookingBySpecialtySchema,
        },
        summary: (p) => `inició reserva con médico ${p.doctorId}`,
        blocksInput: true,
        cancel: 'IDLE',
        idFields: ['doctorId'],
        on: {
          SELECT_PATIENT: {
            to: 'CONFIRM_BOOKING',
            keep: ['doctorId', 'slot'],
          },
          NEW_DEPENDENT_PATIENT: {
            to: 'REGISTER_PATIENT',
            keep: ['doctorId', 'slot'],
          },
        },
      },

      REGISTER_PATIENT: {
        widget: new RegisterPatientWidget(),
        llmTool: {
          description:
            'Abre el formulario para inscribir una nueva carga familiar o paciente.',
        },
        summary: () => 'abrió el formulario de registro de paciente',
        blocksInput: true,
        cancel: (_ctx, meta) =>
          meta.previousState === 'START_BOOKING'
            ? { to: 'START_BOOKING', keep: ['doctorId', 'slot'] }
            : 'IDLE',
        on: {
          PATIENT_REGISTERED: [
            {
              to: 'CONFIRM_BOOKING',
              when: (_ctx, meta) => meta.previousState === 'START_BOOKING',
              keep: ['doctorId', 'slot'],
            },
            {
              to: 'IDLE',
            },
          ],
        },
      },

      CONFIRM_BOOKING: {
        widget: new ConfirmBookingWidget(),
        // Sin llmTool: el LLM no puede saltar directo al checkout de la cita
        summary: (p) =>
          `preparó reserva con ${p.doctorId} para paciente ${p.patientId}`,
        blocksInput: true,
        cancel: 'IDLE',
        idFields: ['doctorId', 'patientId'],
        on: {
          CONFIRM_APPOINTMENT: {
            to: 'BOOKING_TICKET',
            keep: ['doctorId', 'patientId', 'slot'],
          },
        },
      },

      BOOKING_TICKET: {
        widget: new BookingTicketWidget(),
        // Sin llmTool: solo alcanzable tras confirmar la cita; el backend genera `appointmentId`
        summary: (p) => `confirmó cita médica #${p.appointmentId}`,
        blocksInput: false,
        cancel: null,
        idFields: ['appointmentId'],
      },

      UNKNOWN: {
        widget: new UnknownWidget(),
        llmTool: {
          description:
            'Úsala cuando la pregunta del usuario no tenga relación con servicios de la clínica.',
        },
        summary: () => 'realizó consulta fuera de alcance',
        blocksInput: false,
        cancel: null,
      },
    },
  });
