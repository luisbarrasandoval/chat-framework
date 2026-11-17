import assert from 'node:assert/strict';
import {
  ChatSecurityError,
  ChatStateError,
  ChatValidationError,
  type LLMAdapter,
} from '../../src/index.js';
import { createClinicChat } from './clinic-chat.js';

const mockClinicLLM: LLMAdapter = {
  async selectTool({ userMessage }) {
    const q = userMessage.toLowerCase();
    if (q.includes('cardiólogo') || q.includes('cardiologo')) {
      return { name: 'SEARCH_DOCTORS', arguments: { specialty: 'Cardiología' } };
    }
    if (q.includes('horarios') && q.includes('elena')) {
      return { name: 'DOCTOR_DETAIL', arguments: { doctorId: 'doc-101' } };
    }
    if (q.includes('agendar') && q.includes('pediatría')) {
      return {
        name: 'START_BOOKING',
        arguments: { specialty: 'Pediatría', slot: '2026-11-20 10:00' },
      };
    }
    if (q.includes('hack-confirm')) {
      return {
        name: 'CONFIRM_BOOKING',
        arguments: { doctorId: 'doc-101', patientId: 'pat-ajeno', slot: '10:00' },
      };
    }
    return { name: 'UNKNOWN', arguments: {} };
  },
};

async function runClinicVerification() {
  const chat = createClinicChat(
    'sesion-clinica-01',
    { userId: 'usr-99' },
    { llm: mockClinicLLM },
  );

  // 1. Buscar cardiólogos -> expone doc-101 desde el backend
  const res1 = await chat.sendMessage('Busco hora con un cardiólogo');
  assert.equal(res1.state, 'SEARCH_DOCTORS');
  assert.equal(res1.component, 'DOCTOR_LIST');

  // 2. Ver detalle de la Dra. Elena Gómez (doc-101 ya está en la allowlist de la sesión)
  const res2 = await chat.sendMessage('¿Qué horarios tiene la Dra. Elena Gómez?');
  assert.equal(res2.state, 'DOCTOR_DETAIL');
  assert.equal(res2.context.doctorId, 'doc-101');

  // 3. Iniciar reserva desde evento de UI -> el backend devuelve `pat-usr-99`
  const res3 = await chat.sendEvent('BOOK_WITH_DOCTOR', {
    doctorId: 'doc-101',
    slot: '2026-11-20 10:00',
  });
  assert.equal(res3.state, 'START_BOOKING');
  assert.equal(res3.blocksInput, true);

  // 4. PRUEBA DE SEGURIDAD (Anti-Inyección de ID por Cliente):
  // Si el cliente intenta enviar `patientId: "pat-DE-OTRO-USUARIO"` en SELECT_PATIENT,
  // el framework lo rechaza de forma atómica y mantiene la sesión en START_BOOKING.
  await assert.rejects(
    async () => {
      await chat.sendEvent('SELECT_PATIENT', {
        patientId: 'pat-DE-OTRO-USUARIO',
        slot: '2026-11-20 10:00',
      });
    },
    (err: unknown) => {
      assert(err instanceof ChatSecurityError);
      return true;
    },
  );
  assert.equal(chat.getCurrentState(), 'START_BOOKING');

  // 5. Sub-flujo de inscripción de carga familiar:
  // El cliente solo envía `{ dependentName: 'Lucas' }` (sin ID); el backend genera `pat-usr-99-dep-01`.
  await chat.sendEvent('NEW_DEPENDENT_PATIENT', {});
  assert.equal(chat.getCurrentState(), 'REGISTER_PATIENT');

  // Si un cliente malicioso intenta inyectar un `patientId` ajeno en el evento PATIENT_REGISTERED:
  await assert.rejects(
    async () => {
      await chat.sendEvent('PATIENT_REGISTERED', {
        dependentName: 'Lucas',
        patientId: 'pat-DE-OTRO-USUARIO',
      } as any);
    },
    (err: unknown) => {
      assert(err instanceof ChatSecurityError);
      return true;
    },
  );
  assert.equal(chat.getCurrentState(), 'REGISTER_PATIENT');

  // Envío legítimo sin ID: el backend genera `pat-usr-99-dep-01`
  const res5 = await chat.sendEvent('PATIENT_REGISTERED', {
    dependentName: 'Lucas',
  });
  assert.equal(res5.state, 'CONFIRM_BOOKING');
  assert.equal(res5.context.patientId, 'pat-usr-99-dep-01');
  assert.equal(res5.context.doctorId, 'doc-101');
  assert.equal(res5.context.slot, '2026-11-20 10:00');

  // 6. Confirmar la cita: el backend genera `appointmentId: "apt-usr-99-9001"`
  const res6 = await chat.sendEvent('CONFIRM_APPOINTMENT', {});
  assert.equal(res6.state, 'BOOKING_TICKET');
  assert.equal(res6.context.appointmentId, 'apt-usr-99-9001');
  assert.equal(res6.blocksInput, false);

  // 7. Prueba de `llmTool.schema`: invocación en lenguaje natural resolviendo `doctorId` en el backend
  const res7 = await chat.sendMessage('Quiero agendar con Pediatría a las 10:00');
  assert.equal(res7.state, 'START_BOOKING');
  assert.equal(res7.context.doctorId, 'doc-102');

  // 8. Prueba de `blocksInput`: enviar mensaje libre estando en START_BOOKING lanza ChatStateError
  await assert.rejects(
    async () => {
      await chat.sendMessage('Hola');
    },
    (err: unknown) => {
      assert(err instanceof ChatStateError);
      return true;
    },
  );

  // Cancelar libera el flujo y permite seguir conversando
  await chat.cancel();
  assert.equal(chat.getCurrentState(), 'IDLE');

  // 9. Prueba de bloqueo si el LLM intenta saltar a un estado sin `llmTool`
  await assert.rejects(
    async () => {
      await chat.sendMessage('hack-confirm');
    },
    (err: unknown) => {
      assert(err instanceof ChatSecurityError);
      return true;
    },
  );

  // Evitar warning de import no usado
  assert(ChatValidationError);

  console.log('✅ Ejemplo executable examples/clinic verificado exitosamente.');
}

runClinicVerification().catch((err) => {
  console.error(err);
  process.exit(1);
});
