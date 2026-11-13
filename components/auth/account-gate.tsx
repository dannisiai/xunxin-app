"use client";

import { useEffect, type ReactNode } from "react";
import { AccountProvider } from "@/lib/account-context";
import { saveActiveAccountId, type AccountProfile } from "@/lib/account-client";

const localAccount: AccountProfile = { id: "local_user", username: "local_user", displayName: "本地用户", status: "active" };
const noop = async () => {};

export function AccountGate({ children }: { children: ReactNode; onBack?: () => void; showEntryForm?: boolean }) {
  useEffect(() => { saveActiveAccountId(localAccount.id); }, []);
  return <AccountProvider account={localAccount} refreshAccount={noop} logout={noop}>{children}</AccountProvider>;
}
