import { notFound } from "next/navigation";
import { VoiceCallPreview } from "@/components/chat/voice-call-preview";

export default function VoiceCallPreviewPage() {
    if (process.env.NODE_ENV !== "development") notFound();
    return <VoiceCallPreview />;
}
