import { RepoDangerForm } from "../repo-settings-form";
import { repoSettingsContext } from "../context";

export default async function RepoDangerPage({ params }: { params: Promise<{ org: string; repo: string }> }) {
  const { repo } = await repoSettingsContext(params);
  return <RepoDangerForm repositoryId={repo.id} name={repo.name} />;
}
