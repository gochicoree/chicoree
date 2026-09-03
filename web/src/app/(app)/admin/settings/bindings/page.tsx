import type { Metadata } from "next";
import { getInstanceSettings } from "@/lib/instance-settings";
import { BindingsForm } from "../forms";

export const metadata: Metadata = { title: "Group bindings" };

export default async function AdminBindingSettings() {
  const s = await getInstanceSettings();
  return <BindingsForm text={s.bindings} source={s.sources.bindings} />;
}
