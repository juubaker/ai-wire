/**
 * The provider contract.
 *
 * Everything model-specific lives behind this shape. The wire builds one prompt,
 * hands it to whichever provider is selected, and gets back plain text that it
 * parses as JSON. Nothing above this layer knows which vendor answered.
 *
 * Add a vendor by writing one of these and registering it in ./index.js.
 * Do not touch App.jsx or wire-api.js to do it.
 *
 * @typedef {object} Provider
 * @property {string}   id            Stable key used in URLs and saved settings.
 * @property {string}   label         Shown in the picker.
 * @property {string}   docs          Link to the vendor's API reference.
 * @property {string[]} models        Offered in the picker; first is the default.
 * @property {boolean}  supportsSearch Whether the model can reach the live web.
 *                                    False means the wire warns that results are
 *                                    limited to what the model already knows.
 * @property {string}   envKey        Name of the env var holding the API key.
 *                                    Empty string for providers that need none.
 * @property {(env: Record<string,string>) => string} endpoint
 *                                    Upstream URL. Takes env so a local runtime
 *                                    can be pointed somewhere else.
 * @property {(key: string, env?: Record<string,string>) => Record<string,string>} headers
 *                                    Auth and version headers, applied server-side.
 *                                    Takes env too, because some vendors need a
 *                                    second piece of account context alongside
 *                                    the key (a workspace, org or project id).
 * @property {(args: {prompt: string, model: string, search: boolean}) => object} buildBody
 *                                    The vendor's request body.
 * @property {(json: object) => string} extractText
 *                                    Pull the assistant's text out of the response.
 *                                    Tool-call and citation blocks are dropped here.
 * @property {(json: object) => string|null} [extractError]
 *                                    Vendor-shaped error message, if the call failed.
 */

export const JSON_ONLY =
  "Return ONLY a JSON array. No prose, no markdown fences, no explanation before or after.";
