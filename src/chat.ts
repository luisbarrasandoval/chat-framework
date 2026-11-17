import type {
  AllEventNamesOf,
  AnyWidget,
  ChatConfig,
  ChatResponse,
  ComponentOf,
  EventPayloadOf,
  EventsOf,
  LLMToolDefinition,
  NavigationMeta,
  StateNode,
  TransitionRule,
} from './types.js';
import { zodToOpenAIToolParameters } from './zod-schema.js';

export class ChatSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatSecurityError';
  }
}

export class ChatStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatStateError';
  }
}

export class ChatValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatValidationError';
  }
}

export class Chat<TWidgets extends Record<string, AnyWidget>> {
  private readonly config: ChatConfig<TWidgets>;
  private readonly allKnownIdFields: Set<string>;

  constructor(config: ChatConfig<TWidgets>) {
    this.config = config;
    this.allKnownIdFields = new Set<string>();
    for (const state of Object.values(this.config.states)) {
      for (const field of state.idFields ?? []) {
        this.allKnownIdFields.add(field);
      }
    }
    this.config.memory.getSession(this.config.chatId, this.config.initialState);
  }

  getCurrentState(): keyof TWidgets & string {
    const session = this.config.memory.getSession(
      this.config.chatId,
      this.config.initialState,
    );
    return session.currentState as keyof TWidgets & string;
  }

  async sendMessage(userMessage: string): Promise<ChatResponse<TWidgets>> {
    const session = this.config.memory.getSession(
      this.config.chatId,
      this.config.initialState,
    );
    const currentStateKey = session.currentState as keyof TWidgets & string;
    const currentStateNode = this.config.states[currentStateKey];

    if (currentStateNode.blocksInput) {
      throw new ChatStateError(
        `Input bloqueado en el estado "${currentStateKey}". Complete o cancele el flujo actual.`,
      );
    }

    const tools = this.buildLLMTools();
    const toolCall = await this.config.llm.selectTool({
      systemPrompt: this.config.systemPrompt,
      turns: session.turns,
      tools,
      userMessage,
    });

    const targetStateKey = toolCall.name as keyof TWidgets & string;
    const targetStateNode = this.config.states[targetStateKey];

    if (!targetStateNode || !targetStateNode.llmTool) {
      throw new ChatSecurityError(
        `El LLM intentó acceder a un estado no permitido o inexistente: "${String(targetStateKey)}"`,
      );
    }

    const rawContext = { ...toolCall.arguments };

    // Ningún argumento entrante puede contener un idField no emitido previamente por el backend en esta sesión
    this.validateIncomingIdFields(rawContext);

    if (targetStateNode.llmTool.schema) {
      const result = targetStateNode.llmTool.schema.safeParse(rawContext);
      if (!result.success) {
        const messages = result.error.issues
          .map((i) => `${i.path.join('.') || targetStateKey}: ${i.message}`)
          .join('; ');
        throw new ChatValidationError(
          `Validación Zod falló en "${targetStateKey}": ${messages}`,
        );
      }
      return this.enterState({
        targetStateKey,
        nextContext: result.data as Record<string, any>,
        userMessage,
      });
    }

    this.validateRequiredIdFields(targetStateKey, targetStateNode, rawContext);
    const parsedContext = this.parseAndValidateWithZod(
      targetStateKey,
      targetStateNode,
      rawContext,
    );

    return this.enterState({
      targetStateKey,
      nextContext: parsedContext,
      userMessage,
    });
  }

  async sendEvent<
    KCurrent extends keyof TWidgets & string = keyof TWidgets & string,
    E extends AllEventNamesOf<TWidgets> = AllEventNamesOf<TWidgets>,
  >(
    eventName: E,
    payload: EventPayloadOf<TWidgets, E> = {} as EventPayloadOf<TWidgets, E>,
  ): Promise<ChatResponse<TWidgets>> {
    const session = this.config.memory.getSession(
      this.config.chatId,
      this.config.initialState,
    );
    const currentStateKey = session.currentState as keyof TWidgets & string;
    const currentStateNode = this.config.states[currentStateKey];

    const rawRules =
      currentStateNode.on?.[
        eventName as keyof EventsOf<TWidgets[typeof currentStateKey]>
      ];
    if (!rawRules) {
      throw new ChatStateError(
        `El evento "${String(eventName)}" no está soportado en el estado "${currentStateKey}".`,
      );
    }

    // Validamos que el payload del cliente NO inyecte ningún idField ajeno a la allowlist de la sesión
    if (payload && typeof payload === 'object') {
      this.validateIncomingIdFields(payload as Record<string, any>);
    }

    const rules = (Array.isArray(rawRules) ? rawRules : [rawRules]) as Array<
      TransitionRule<TWidgets, typeof currentStateKey, Record<string, any>>
    >;

    const combinedForGuard = {
      ...session.context,
      ...(payload as Record<string, any>),
    };

    const navMeta: NavigationMeta<keyof TWidgets & string> = {
      previousState: session.previousState as (keyof TWidgets & string) | null,
      history: session.history as Array<keyof TWidgets & string>,
    };

    const matchedRule = rules.find((rule) =>
      rule.when ? rule.when(combinedForGuard as any, navMeta) : true,
    );

    if (!matchedRule) {
      throw new ChatStateError(
        `Ninguna regla de transición cumplió la condición para el evento "${String(eventName)}" desde "${currentStateKey}".`,
      );
    }

    const keptContext: Record<string, any> = {};
    if (matchedRule.keep) {
      for (const key of matchedRule.keep) {
        if (session.context[key] !== undefined) {
          keptContext[key] = session.context[key];
        }
      }
    }

    const rawContext: Record<string, any> = {
      ...keptContext,
      ...(payload as Record<string, any>),
    };

    const targetStateKey = matchedRule.to;

    return this.enterState({
      targetStateKey,
      nextContext: rawContext,
      event: String(eventName),
    });
  }

  async cancel(): Promise<ChatResponse<TWidgets>> {
    const session = this.config.memory.getSession(
      this.config.chatId,
      this.config.initialState,
    );
    const currentStateKey = session.currentState as keyof TWidgets & string;
    const currentStateNode = this.config.states[currentStateKey];

    if (!currentStateNode.cancel) {
      throw new ChatStateError(
        `El estado "${currentStateKey}" no permite cancelación.`,
      );
    }

    let targetStateKey: keyof TWidgets & string;
    const nextContext: Record<string, any> = {};

    if (typeof currentStateNode.cancel === 'function') {
      const navMeta: NavigationMeta<keyof TWidgets & string> = {
        previousState: session.previousState as (keyof TWidgets & string) | null,
        history: session.history as Array<keyof TWidgets & string>,
      };
      const resolved = currentStateNode.cancel(session.context as any, navMeta);
      if (typeof resolved === 'string') {
        targetStateKey = resolved;
      } else {
        targetStateKey = resolved.to;
        for (const key of resolved.keep ?? []) {
          if (session.context[key] !== undefined) {
            nextContext[key] = session.context[key];
          }
        }
      }
    } else {
      targetStateKey = currentStateNode.cancel;
    }

    return this.enterState({
      targetStateKey,
      nextContext,
      event: 'CANCEL',
    });
  }

  private buildLLMTools(): LLMToolDefinition[] {
    const tools: LLMToolDefinition[] = [];
    for (const [stateName, stateNode] of Object.entries(this.config.states)) {
      if (!stateNode.llmTool) continue;
      tools.push({
        name: stateName,
        description: stateNode.llmTool.description,
        parameters: zodToOpenAIToolParameters(
          stateNode.llmTool.schema ?? stateNode.widget.schema,
        ),
      });
    }
    return tools;
  }

  /**
   * Verifica que cualquier campo catalogado como `idField` en la máquina que venga
   * en el input (del LLM o de un evento de UI) haya sido emitido previamente por el backend
   * (`widget.execute`) en esta sesión.
   */
  private validateIncomingIdFields(incoming: Record<string, any>): void {
    for (const [key, value] of Object.entries(incoming)) {
      if (value === undefined || value === null) continue;
      if (this.allKnownIdFields.has(key)) {
        if (!this.config.memory.isIdAllowed(this.config.chatId, key, String(value))) {
          throw new ChatSecurityError(
            `Acceso denegado: el identificador ${key}="${String(value)}" no pertenece al contexto de esta sesión.`,
          );
        }
      }
    }
  }

  /**
   * Verifica que todos los `idFields` requeridos por el estado destino estén presentes
   * y registrados en la allowlist de la sesión.
   */
  private validateRequiredIdFields<K extends keyof TWidgets & string>(
    stateKey: K,
    stateNode: StateNode<TWidgets, K>,
    context: Record<string, any>,
  ): void {
    if (!stateNode.idFields || stateNode.idFields.length === 0) return;

    for (const field of stateNode.idFields) {
      const value = context[field];
      if (!value) {
        throw new ChatSecurityError(
          `El estado "${stateKey}" requiere el identificador "${field}".`,
        );
      }
      if (!this.config.memory.isIdAllowed(this.config.chatId, field, String(value))) {
        throw new ChatSecurityError(
          `Acceso denegado: el identificador ${field}="${String(value)}" no pertenece al contexto de esta sesión.`,
        );
      }
    }
  }

  private parseAndValidateWithZod<K extends keyof TWidgets & string>(
    stateKey: K,
    stateNode: StateNode<TWidgets, K>,
    context: Record<string, any>,
  ): Record<string, any> {
    const schema = stateNode.widget.schema;
    if (!schema) return context;

    const result = schema.safeParse(context);
    if (!result.success) {
      const messages = result.error.issues
        .map((i) => `${i.path.join('.') || stateKey}: ${i.message}`)
        .join('; ');
      throw new ChatValidationError(
        `Validación Zod falló en "${stateKey}": ${messages}`,
      );
    }

    return result.data as Record<string, any>;
  }

  private async enterState<K extends keyof TWidgets & string>(params: {
    targetStateKey: K;
    nextContext: Record<string, any>;
    userMessage?: string;
    event?: string;
  }): Promise<ChatResponse<TWidgets>> {
    const stateNode = this.config.states[params.targetStateKey];
    const widget = stateNode.widget;

    // Si el estado es 'client', validamos idFields y Zod inmediatamente.
    // Si el estado es 'backend', primero validamos cualquier idField ya presente;
    // si falta un idField que aún no fue generado (ej. creación en backend de recipientId / transactionId / appointmentId),
    // primero validamos el resto del schema o ejecutamos widget.execute() para que el backend lo genere y registre.
    const workingContext = { ...params.nextContext };
    this.validateIncomingIdFields(workingContext);

    // Si todos los idFields requeridos ya vienen en workingContext, validamos el schema completo antes de ejecutar el backend
    const missingIdField = (stateNode.idFields ?? []).some(
      (f) => workingContext[f] === undefined,
    );
    if (!missingIdField && !stateNode.llmTool?.schema) {
      this.validateRequiredIdFields(params.targetStateKey, stateNode, workingContext);
      const parsedBefore = this.parseAndValidateWithZod(
        params.targetStateKey,
        stateNode,
        workingContext,
      );
      Object.assign(workingContext, parsedBefore);
    }

    let data: unknown = null;
    if (widget.dataSource === 'backend' && widget.execute) {
      data = await widget.execute(workingContext, this.config.principal);
      const extracted = this.extractAndRegisterIds(data);
      // Si el backend creó o resolvió una entidad cuyo idField no venía aún en el contexto,
      // sincronizamos ese idField generado por el servidor en workingContext.
      for (const field of stateNode.idFields ?? []) {
        if (workingContext[field] === undefined && extracted[field]?.length === 1) {
          workingContext[field] = extracted[field][0];
        }
      }
    }

    // Invariante final antes de confirmar la transición en memoria:
    // 1. Todos los idFields requeridos por el estado deben existir y estar en la allowlist (emitidos por backend).
    // 2. El contexto final debe cumplir el schema Zod del estado.
    this.validateRequiredIdFields(params.targetStateKey, stateNode, workingContext);
    const finalContext = stateNode.llmTool?.schema
      ? workingContext
      : this.parseAndValidateWithZod(params.targetStateKey, stateNode, workingContext);

    const rawSummary = stateNode.summary
      ? stateNode.summary(finalContext as any, data as any)
      : undefined;

    const summaryText = rawSummary
      ? rawSummary.replace(/[\r\n]+/g, ' ').trim()
      : undefined;

    const updatedSession = this.config.memory.recordTransition(this.config.chatId, {
      nextState: params.targetStateKey,
      context: finalContext,
      summary: summaryText,
      userMessage: params.userMessage,
      event: params.event,
    });

    return {
      chatId: this.config.chatId,
      state: params.targetStateKey,
      previousState: updatedSession.previousState as (keyof TWidgets & string) | null,
      component: widget.component as ComponentOf<TWidgets[keyof TWidgets & string]>,
      dataSource: widget.dataSource,
      blocksInput: stateNode.blocksInput,
      canCancel: stateNode.cancel !== null,
      context: { ...finalContext },
      data,
      summary: summaryText,
    };
  }

  private extractAndRegisterIds(
    payload: unknown,
    collected: Record<string, string[]> = {},
  ): Record<string, string[]> {
    if (!payload || typeof payload !== 'object') return collected;

    if (Array.isArray(payload)) {
      for (const item of payload) {
        this.extractAndRegisterIds(item, collected);
      }
      return collected;
    }

    const record = payload as Record<string, unknown>;
    for (const [key, value] of Object.entries(record)) {
      if (
        (typeof value === 'string' || typeof value === 'number') &&
        this.allKnownIdFields.has(key)
      ) {
        const strVal = String(value);
        this.config.memory.registerAllowedIds(this.config.chatId, key, [strVal]);
        if (!collected[key]) collected[key] = [];
        if (!collected[key].includes(strVal)) collected[key].push(strVal);
      } else if (typeof value === 'object' && value !== null) {
        this.extractAndRegisterIds(value, collected);
      }
    }
    return collected;
  }
}
