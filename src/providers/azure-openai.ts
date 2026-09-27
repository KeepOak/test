import type { Completion, CompletionRequest, Provider } from "../contracts.js";
import { rejectedHttpResponse } from "../provider-retry.js";
import { OpenAIStream, readEventStream } from "../provider-stream.js";
import { openaiBody, openaiCompletion, readJsonBody, restoreToolNames } from "../providers.js";

/**
 * Azure's own copy of OpenAI. It speaks the same shape, but the address names a deployment the
 * owner created rather than a model, the version of the API is part of the address, and the key
 * goes in a header Azure names itself. Everything else is the ordinary OpenAI shape.
 */
export interface AzureOptions {
  /** https://<resource>.openai.azure.com/openai/deployments/<deployment> */
  endpoint: string;
  /** The model behind the deployment; sent so the reply and the bill can be read back. */
  model: string;
  apiKey: string;
  apiVersion: string;
  fetchImpl?: typeof globalThis.fetch;
}

/** The exact address a request goes to, with the dated version of the API on the end. */
export function azureUrl(endpoint: string, path: string, apiVersion: string): string {
  const url = new URL(endpoint.replace(/\/$/, "") + path);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error("Azure OpenAI endpoint requires HTTPS (HTTP is allowed only on loopback)");
  if (url.username || url.password || url.hash) throw new Error("Azure OpenAI endpoint must not contain credentials or fragment");
  url.searchParams.set("api-version", apiVersion);
  return url.toString();
}

export class AzureOpenAIProvider implements Provider {
  readonly name = "azure-openai";
  readonly acceptsImages = true;
  private readonly fetchImpl: typeof globalThis.fetch;
  /** The model this connection asks for (src/contracts.ts Provider.model). */
  get model(): string { return this.options.model; }
  constructor(private readonly options: AzureOptions) {
    if (!options.model || !options.apiKey) throw new Error("Azure OpenAI model and API key are required");
    if (!/^\d{4}-\d{2}-\d{2}(-preview)?$/.test(options.apiVersion))
      throw new Error("The Azure API version looks like 2024-10-01-preview");
    azureUrl(options.endpoint, "/chat/completions", options.apiVersion);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }
  /** Azure serves speech and embeddings from the same resource, under the same key. */
  audio(): { endpoint: string; apiKey: string } | null {
    return { endpoint: this.options.endpoint, apiKey: this.options.apiKey };
  }
  embeddings(): { endpoint: string; apiKey: string } | null {
    return { endpoint: this.options.endpoint, apiKey: this.options.apiKey };
  }
  images(): null { return null; }
  supportsImages(): boolean { return true; }
  /** Azure lists deployments, not models, and at the resource rather than the deployment address. */
  modelsList(): { url: string; headers: Record<string, string> } | null {
    const resource = this.options.endpoint.replace(/\/openai\/deployments\/.*$/, "");
    return { url: azureUrl(resource, "/openai/models", this.options.apiVersion), headers: { "api-key": this.options.apiKey } };
  }
  private headers(): Record<string, string> {
    return { "content-type": "application/json", "api-key": this.options.apiKey };
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    const url = azureUrl(this.options.endpoint, "/chat/completions", this.options.apiVersion);
    const body = openaiBody(request, this.options.model);
    if (request.onTextDelta) {
      const stream = new OpenAIStream(request.onTextDelta);
      try {
        const response = await this.post(url, { ...body, stream: true, stream_options: { include_usage: true } }, request.signal);
        await readEventStream(response, (data) => stream.consume(data));
        return restoreToolNames(stream.result(), request);
      } catch (error) { throw stream.failure(error); }
    }
    const response = await this.post(url, body, request.signal);
    return openaiCompletion(await readJsonBody(response), request);
  }
  private async post(url: string, body: unknown, signal: AbortSignal): Promise<Response> {
    const response = await this.fetchImpl(url, {
      method: "POST", headers: this.headers(), body: JSON.stringify(body), signal, redirect: "error",
    });
    if (!response.ok) throw await rejectedHttpResponse(response, signal);
    if (!response.body) throw new Error("Provider returned empty body");
    return response;
  }
}
