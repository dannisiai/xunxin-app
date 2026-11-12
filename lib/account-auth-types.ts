/** Public account-service capabilities. Never include credentials or provider tokens. */
export type AccountAuthConfig = {
  provider: "supabase" | "sub2api";
  registrationEnabled: boolean;
  emailVerificationRequired: boolean;
  passwordRequired: boolean;
  codeLoginEnabled: boolean;
  invitationRequired: boolean;
  emailSuffixWhitelist: string[];
  requiresAccountCenter: boolean;
  accountCenterUrl?: string;
};
