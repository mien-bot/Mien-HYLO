import AnthropicModule from '@anthropic-ai/sdk'

// Handle ESM default export wrapping (same pattern as electron-store)
const Anthropic =
  (AnthropicModule as typeof AnthropicModule & { default?: typeof AnthropicModule }).default ||
  AnthropicModule

export default Anthropic as typeof AnthropicModule
