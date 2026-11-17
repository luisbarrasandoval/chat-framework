import type { z } from 'zod';

export interface Principal {
  userId: string;
  companyId?: string;
  roles?: string[];
}

export interface JsonSchemaProperty {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

export interface ToolParametersSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/**
 * Contrato base de un Widget (100% agnóstico de industria).
 * - TInput: Datos de contexto/entrada que recibe el estado (validados por `schema` de Zod).
 * - TEvents: Eventos de UI que puede emitir hacia la máquina de estados.
 * - TComponent: Nombre del componente SDUI a renderizar en el cliente.
 * - TOutput: Datos devueltos por `execute()` cuando `dataSource === 'backend'`.
 */
export interface Widget<
  TInput extends Record<string, any> = Record<string, never>,
  TEvents extends Record<string, Record<string, any>> = Record<string, never>,
  TComponent extends string = string,
  TOutput = any,
> {
  readonly component: TComponent;
  readonly dataSource: 'client' | 'backend';
  readonly schema?: z.ZodType<TInput, any, any>;
  readonly __input?: TInput;
  readonly __events?: TEvents;
  readonly __output?: TOutput;
  execute?(input: TInput, principal: Principal): Promise<TOutput> | TOutput;
}

export abstract class BaseWidget<
  TInput extends Record<string, any> = Record<string, never>,
  TEvents extends Record<string, Record<string, any>> = Record<string, never>,
  TComponent extends string = string,
  TOutput = any,
> implements Widget<TInput, TEvents, TComponent, TOutput>
{
  abstract readonly component: TComponent;
  abstract readonly dataSource: 'client' | 'backend';
  readonly schema?: z.ZodType<TInput, any, any>;
  declare readonly __input?: TInput;
  declare readonly __events?: TEvents;
  declare readonly __output?: TOutput;
  execute?(input: TInput, principal: Principal): Promise<TOutput> | TOutput;
}

export type AnyWidget = Widget<any, any, any, any>;

export type InputOf<W extends AnyWidget> = NonNullable<W['__input']>;
export type EventsOf<W extends AnyWidget> = NonNullable<W['__events']>;
export type ComponentOf<W extends AnyWidget> = W['component'];
export type OutputOf<W extends AnyWidget> = NonNullable<W['__output']>;

export type AllEventNamesOf<TWidgets extends Record<string, AnyWidget>> = {
  [K in keyof TWidgets]: keyof EventsOf<TWidgets[K]> & string;
}[keyof TWidgets];

export type EventPayloadOf<
  TWidgets extends Record<string, AnyWidget>,
  E extends string,
> = {
  [K in keyof TWidgets]: E extends keyof EventsOf<TWidgets[K]>
    ? EventsOf<TWidgets[K]>[E]
    : never;
}[keyof TWidgets];

/**
 * Metadatos de navegación gestionados por el framework.
 */
export interface NavigationMeta<TStateName extends string = string> {
  readonly previousState: TStateName | null;
  readonly history: readonly TStateName[];
}

/**
 * Regla de transición tipada entre el estado KFrom y cualquier estado KTo.
 */
export type TransitionRule<
  TWidgets extends Record<string, AnyWidget>,
  KFrom extends keyof TWidgets & string,
  TEventPayload extends Record<string, any>,
> = {
  [KTo in keyof TWidgets & string]: {
    to: KTo;
    when?: (
      ctx: InputOf<TWidgets[KFrom]> & TEventPayload,
      meta: NavigationMeta<keyof TWidgets & string>,
    ) => boolean;
    keep?: Array<Extract<keyof InputOf<TWidgets[KFrom]>, keyof InputOf<TWidgets[KTo]>> & string>;
  };
}[keyof TWidgets & string];

/**
 * Config de cancelación: estado estático o función dinámica según contexto/navegación.
 */
export type CancelConfig<
  TWidgets extends Record<string, AnyWidget>,
  K extends keyof TWidgets & string,
> =
  | (keyof TWidgets & string)
  | null
  | ((
      ctx: InputOf<TWidgets[K]>,
      meta: NavigationMeta<keyof TWidgets & string>,
    ) =>
      | {
          to: keyof TWidgets & string;
          keep?: Array<keyof InputOf<TWidgets[K]> & string>;
        }
      | (keyof TWidgets & string));

/**
 * Definición de un estado dentro de la máquina.
 */
export type StateNode<
  TWidgets extends Record<string, AnyWidget>,
  K extends keyof TWidgets & string,
> = {
  widget: TWidgets[K];
  llmTool?: {
    description: string;
    /**
     * Esquema Zod opcional para los argumentos que envía el LLM cuando el estado
     * se invoca con datos naturales (ej. RUT, nombre, especialidad) y `widget.execute()`
     * resuelve internamente el `idField` en el backend.
     */
    schema?: z.ZodTypeAny;
  };
  blocksInput: boolean;
  cancel: CancelConfig<TWidgets, K>;
  summary?: (p: InputOf<TWidgets[K]>, data: OutputOf<TWidgets[K]>) => string;
  idFields?: Array<keyof InputOf<TWidgets[K]> & string>;
  on?: {
    [E in keyof EventsOf<TWidgets[K]>]?:
      | TransitionRule<TWidgets, K, EventsOf<TWidgets[K]>[E]>
      | Array<TransitionRule<TWidgets, K, EventsOf<TWidgets[K]>[E]>>;
  };
};

export interface LLMToolDefinition {
  name: string;
  description: string;
  parameters: ToolParametersSchema;
}

export interface LLMToolCall {
  name: string;
  arguments: Record<string, any>;
}

export interface MemoryTurn {
  userMessage?: string;
  event?: string;
  state: string;
  summary: string;
  timestamp: number;
}

export interface SessionSnapshot<TStateName extends string = string> {
  currentState: TStateName;
  previousState: TStateName | null;
  history: TStateName[];
  context: Record<string, any>;
  turns: MemoryTurn[];
  allowedIds: Record<string, Set<string>>;
}

export interface ChatMemory {
  getSession(chatId: string, initialState: string): SessionSnapshot;
  recordTransition(
    chatId: string,
    params: {
      nextState: string;
      context: Record<string, any>;
      summary?: string;
      userMessage?: string;
      event?: string;
      exposedIds?: Record<string, string[]>;
    },
  ): SessionSnapshot;
  isIdAllowed(chatId: string, field: string, value: string): boolean;
  registerAllowedIds(chatId: string, field: string, values: string[]): void;
  clearSession?(chatId: string): void;
}

export interface LLMAdapter {
  selectTool(params: {
    systemPrompt: string;
    turns: MemoryTurn[];
    tools: LLMToolDefinition[];
    userMessage: string;
  }): Promise<LLMToolCall>;
}

export interface ChatConfig<TWidgets extends Record<string, AnyWidget>> {
  chatId: string;
  principal: Principal;
  systemPrompt: string;
  llm: LLMAdapter;
  memory: ChatMemory;
  initialState: keyof TWidgets & string;
  states: {
    [K in keyof TWidgets & string]: StateNode<TWidgets, K>;
  };
}

export interface ChatResponse<TWidgets extends Record<string, AnyWidget>> {
  chatId: string;
  state: keyof TWidgets & string;
  previousState: (keyof TWidgets & string) | null;
  component: ComponentOf<TWidgets[keyof TWidgets & string]>;
  dataSource: 'client' | 'backend';
  blocksInput: boolean;
  canCancel: boolean;
  context: Record<string, any>;
  data: unknown;
  summary?: string;
}
