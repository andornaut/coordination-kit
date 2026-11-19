// Shapes of private keys and access tokens that `msg send` refuses in a body. The patterns favour
// recall over precision: a refused body that holds no secret is rephrased by its sender.
export const SECRET_SHAPES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "private-key", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  {
    name: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/,
  },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "openai-key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/ },
  { name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
  { name: "slack-token", pattern: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/ },
  { name: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/ },
  { name: "url-credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{6,}@/i },
];

/** The name of the first secret shape `body` matches, or null. */
export function secretShape(body: string): string | null {
  return SECRET_SHAPES.find((shape) => shape.pattern.test(body))?.name ?? null;
}
