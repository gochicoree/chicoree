import { RepoGeneralForm } from "./repo-settings-form";
import { ReadmeEditor } from "./readme-editor";
import { repoSettingsContext } from "./context";

export default async function RepoGeneralSettingsPage({ params }: { params: Promise<{ org: string; repo: string }> }) {
  const { repo } = await repoSettingsContext(params);
  return (
    <div className="space-y-6">
      <RepoGeneralForm repositoryId={repo.id} name={repo.name} description={repo.description} visibility={repo.visibility} />
      <ReadmeEditor repositoryId={repo.id} readme={repo.readme} />
    </div>
  );
}
