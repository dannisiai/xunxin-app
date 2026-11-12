import { notFound } from "next/navigation";
import { AppUpdatePreview } from "@/components/settings/app-update-preview";

export default function AppUpdatePreviewPage() {
    if (process.env.NODE_ENV !== "development") notFound();
    return <AppUpdatePreview />;
}
