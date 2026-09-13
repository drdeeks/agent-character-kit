/**
 * Convert a Character Kit PluginError into an OpenAI-shaped error body.
 * @param {object} error
 */
export function mapOpenAiError(error) {
  return {
    error: {
      message: error.message,
      type: "character_kit_error",
      code: error.code,
      param: null,
    },
  };
}
