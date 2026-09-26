// Measurement-only wrapper: record every SDK inference and underlying HTTP attempt,
// including compaction and retries, without recording prompts, headers or credentials.
export function auditedStream(streamFn, records, pending, serviceTier) {
  return (model, context, options = {}) => {
    const record = {
      id: records.length + 1,
      model: model.id,
      started_at: new Date().toISOString(),
      started_ms: Date.now(),
      http: [],
    };
    records.push(record);
    const request = options.fetch ?? globalThis.fetch;
    const stream = streamFn(model, context, {
      ...options,
      onPayload: async (payload, selected) => {
        const changed = await options.onPayload?.(payload, selected);
        const body = changed ?? payload;
        if (serviceTier) body.service_tier = serviceTier;
        record.request = {
          model: body.model,
          reasoning: body.reasoning?.effort,
          service_tier: body.service_tier,
          tools: (body.tools ?? []).map((t) => t.name),
          input_chars: JSON.stringify(body.input ?? []).length,
        };
        return body;
      },
      fetch: async (...args) => {
        const http = { started_ms: Date.now() };
        record.http.push(http);
        try {
          const response = await request(...args);
          http.status = response.status;
          http.headers_ms = Date.now() - http.started_ms;
          return response;
        } catch (error) {
          http.error = error.name;
          http.headers_ms = Date.now() - http.started_ms;
          throw error;
        }
      },
    });
    const completed = Promise.resolve(stream)
      .then((s) => s.result())
      .then(
        (message) => {
          record.duration_ms = Date.now() - record.started_ms;
          record.stop_reason = message.stopReason;
          record.usage = message.usage;
        },
        (error) => {
          record.duration_ms = Date.now() - record.started_ms;
          record.error = error.name;
        },
      );
    pending.push(completed);
    return stream;
  };
}
