import { redirect } from "next/navigation";

// Importing is now a mode of "New repository"; keep the old address working.
export default async function ImportPage({ params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  redirect(`/${slug}/new-repository?mode=mirror`);
}
