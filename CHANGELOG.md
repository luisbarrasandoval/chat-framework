# Changelog

Todas las modificaciones relevantes de este proyecto se documentan en este archivo.
El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el
versionado sigue [Semantic Versioning](https://semver.org/lang/es/).

## [1.0.0] - 2026-11-16

### Añadido

- Máquina de estados finitos tipada (`Chat`) con transiciones determinísticas por eventos.
- Integración con LLM como clasificador de un solo tool call (`tool_choice: "required"`).
- Contratos Server-Driven UI (`component`, `dataSource`, `blocksInput`, `canCancel`).
- Control de referencias de sesión (`idFields`) con allowlist alimentada por el backend.
- Validación de esquemas con Zod y errores atómicos (`ChatStateError`, `ChatSecurityError`, `ChatValidationError`).
- Adaptador de OpenAI (`OpenAIAdapter`) y memoria en proceso (`InMemoryChatMemory`).
- Ejemplo ejecutable de clínica digital en `examples/clinic/`.
