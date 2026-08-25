import { anthropicMessagesApi } from "../api/anthropic-messages.lazy.ts";
import { openAICompletionsApi } from "../api/openai-completions.lazy.ts";
import { openAIResponsesApi } from "../api/openai-responses.lazy.ts";
import { createProvider, type Provider } from "../models.ts";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "./cloudflare-ai-gateway.models.ts";
import { cloudflareAIGatewayAuth } from "./cloudflare-auth.ts";
import { cloudflareStreams } from "./cloudflare-stream.ts";

// The gateway passes Workers AI models through on openai-completions with
// `workers-ai/`-prefixed ids (see the workers-ai branch in
// scripts/generate-models.ts). Upstream is not listing any of them right now,
// so the generated model set carries no openai-completions entry and the api
// key would be inferred away. Pin the parameter so the handler stays wired for
// whenever those models come back.
export function cloudflareAIGatewayProvider(): Provider<
	"anthropic-messages" | "openai-completions" | "openai-responses"
> {
	return createProvider<"anthropic-messages" | "openai-completions" | "openai-responses">({
		id: "cloudflare-ai-gateway",
		name: "Cloudflare AI Gateway",
		auth: { apiKey: cloudflareAIGatewayAuth() },
		models: Object.values(CLOUDFLARE_AI_GATEWAY_MODELS),
		api: {
			"anthropic-messages": cloudflareStreams(anthropicMessagesApi()),
			"openai-completions": cloudflareStreams(openAICompletionsApi()),
			"openai-responses": cloudflareStreams(openAIResponsesApi()),
		},
	});
}
