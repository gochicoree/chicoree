import { env } from "@/lib/env";
import type { Metadata } from "next";
import { getInstanceSettings } from "@/lib/instance-settings";
import { AccessForm } from "./access-form";

export const metadata: Metadata = { title: "Access" };

export default async function AdminAccessSettings() {
  const s = await getInstanceSettings();
  return <AccessForm access={s.access} source={s.sources.access} appUrl={env.appUrl} />;
}
