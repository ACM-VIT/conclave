# 0004. AI model discovery admits known families and adapts provider output

- Status: Accepted
- Date: 2026-11-22

## Context

The OpenAI Models API lists model IDs but not which endpoints or tools a model supports. Claude's model list also carries capability metadata. Provider SDKs add their own shape on top of the wire format, and Claude cannot combine search citations with structured output (`output_config.format`) in a single response.

## Decision

- Discovery admits only the general-purpose Responses families Conclave supports and never infers image or audio support from an arbitrary model ID. Claude capability metadata is checked by the server catalog adapter: a picker model must support structured outputs and web search.
- JSON Schema for Anthropic goes through the SDK's schema adapter, which rewrites unsupported bounds without mutating the shared schema registry.
- OpenAI output parsed by the SDK is rebuilt into plain Responses input items before it is replayed, because SDK parsing adds fields that are not valid input.
- A Claude request that needs both structured output and web search runs a research pass with search first, then decodes the final JSON in a second pass without citation-enabled tools.

## Consequences

- A newly released model appears only once its family is known.
- Structured output with search costs two Claude calls.

## Alternatives considered

- **Admitting every listed ID:** rejected because the picker would offer models that fail at run time.

## Code

- `packages/ai/src/models.ts`: `responseModelProfile`
- `packages/ai/src/catalog-server.ts`
- `packages/ai/src/providers/anthropic.ts`: `anthropicSchema`, structured output with web search
- `packages/ai/src/providers/openai.ts`: Responses input replay
