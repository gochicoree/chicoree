import { LogoUploadCard } from "@/components/logo-upload";
import { saveRepositoryLogo } from "@/app/actions/logos";
import { RepoGeneralForm } from "./repo-settings-form";
import { ReadmeEditor } from "./readme-editor";
import { repoSettingsContext } from "./context";

export default async function RepoGeneralSettingsPage({ params }: { params: Promise<{ org: string; repo: string }> }) {
  const { repo } = await repoSettingsContext(params);
  return (
    <div className="space-y-6">
      <RepoGeneralForm repositoryId={repo.id} name={repo.name} description={repo.description} visibility={repo.visibility} />
      <LogoUploadCard
        action={saveRepositoryLogo}
        kind="repository"
        name={repo.name}
        fields={{ repositoryId: repo.id }}
        initial={repo.logo}
        title="Repository picture"
        description="Shown wherever this repository appears."
      />
      <ReadmeEditor repositoryId={repo.id} readme={repo.readme} />
    </div>
  );
}
