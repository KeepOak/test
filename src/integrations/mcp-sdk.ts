/**
 * The MCP SDK (its client, transports and schema checker) is several megabytes once loaded. It is loaded the first
 * time a server is connected, listed or its tool is called, not when the engine starts: an engine with no MCP server
 * in use never holds it.
 */
export const mcpClient = async () => (await import('@modelcontextprotocol/sdk/client/index.js')).Client;
export const mcpStdio = () => import('@modelcontextprotocol/sdk/client/stdio.js');
export const mcpHttp = async () => (await import('@modelcontextprotocol/sdk/client/streamableHttp.js')).StreamableHTTPClientTransport;
export const mcpValidator = async () => (await import('@modelcontextprotocol/sdk/validation/ajv')).AjvJsonSchemaValidator;
/** The SDK's sign-in (`auth()`), loaded only when the owner signs in to a server. */
export const mcpAuth = () => import('@modelcontextprotocol/sdk/client/auth.js');
