export const STUDIO_MCP_DEFAULT_PORT = 17361;
export const STUDIO_MCP_CONTENT_CHUNK_CHARACTERS = 16_000;

export function isStudioMcpCredentialToken(value: unknown): value is string {
  return typeof value === 'string' && /^asterium_[A-Za-z0-9_-]{43}$/.test(value);
}

export interface StudioMcpConfiguration {
  enabled: boolean;
  port: number;
  publicOrigin: string;
  automationManagementEnabled?: boolean;
}

export interface StudioMcpCredential {
  credentialId: string;
  partnerId: string;
  createdAt: string;
  revokedAt?: string;
}

export interface StudioMcpStatus {
  configuration: StudioMcpConfiguration;
  running: boolean;
  credentials: StudioMcpCredential[];
  lastAuthenticatedAt?: string;
  error?: string;
}

export interface AsteriumStudioMcpApi {
  status(): Promise<StudioMcpStatus>;
  configure(configuration: StudioMcpConfiguration): Promise<StudioMcpStatus>;
  issueCredential(partnerId: string): Promise<{ credential: StudioMcpCredential; token: string }>;
  copyCredential(token: string): Promise<void>;
  revokeCredential(credentialId: string): Promise<StudioMcpStatus>;
}
