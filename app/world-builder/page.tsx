"use client";
import WorldBuilder from "@/components/world-builder/WorldBuilder";
import { AccountGate } from "@/components/auth/account-gate";

export default function WorldBuilderPage() {
    return <AccountGate><WorldBuilder /></AccountGate>;
}
