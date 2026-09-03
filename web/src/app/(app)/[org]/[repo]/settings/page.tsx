import { RepoGeneralForm } from "./repo-settings-form";
import { repoSettingsContext } from "./context";

export default async function RepoGeneralSettingsPage({ params }: { params: Promise<{ org: string; repo: string }> }) {
  const { repo } = await repoSettingsContext(params);
  return <RepoGeneralForm repositoryId={repo.id} name={repo.name} description={repo.description} visibility={repo.visibility} />;
}
