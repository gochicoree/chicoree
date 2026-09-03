import { redirect } from "next/navigation";

export default function AdminSettingsRedirect() {
  redirect("/admin/auth/bindings");
}
