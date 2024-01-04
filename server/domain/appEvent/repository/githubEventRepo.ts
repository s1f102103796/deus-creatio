import type { AppModel, InitAppModel } from '$/commonTypesWithClient/appModels';
import { displayIdToApiOrigin, indexToUrls } from '$/domain/app/query/utils';
import { githubRepo } from '$/domain/app/repository/githubRepo';
import type { RemoteBranch } from '$/domain/app/repository/localGitRepo';
import { localGitRepo } from '$/domain/app/repository/localGitRepo';
import { githubUseCase } from '$/domain/app/useCase/githubUseCase';
import { llmRepo } from '$/domain/appEvent/repository/llmRepo';
import { GITHUB_OWNER, GITHUB_TEMPLATE } from '$/service/envValues';
import { githubApiClient } from '$/service/githubApiClient';
import { setInterval, setTimeout } from 'timers/promises';
import { URL } from 'url';

let calledApiTimes: number[] = [];

const waitApiCallingLimit = async () => {
  const now = Date.now();
  const todayCalledTimes = calledApiTimes.filter((t) => t > now - 24 * 60 * 60 * 1000);
  calledApiTimes = [...todayCalledTimes, now];

  if (todayCalledTimes.length > 4500) await setTimeout(60_000);
};

export const githubEventRepo = {
  createRemote: async (app: InitAppModel) => {
    await waitApiCallingLimit();

    const repoName = app.displayId;
    const urls = indexToUrls(app.index);

    await githubApiClient.repos
      ._owner(GITHUB_OWNER)
      ._repo(GITHUB_TEMPLATE)
      .generate.$post({ body: { owner: GITHUB_OWNER, name: repoName, include_all_branches: true } })
      .catch((e) => {
        if (e.response.status !== 422) throw e;
      });

    await Promise.all(
      [
        { name: 'CNAME', value: new URL(urls.site).host },
        { name: 'API_ORIGIN', value: displayIdToApiOrigin(repoName) },
      ].map((body) =>
        githubApiClient.repos._owner(GITHUB_OWNER)._repo(repoName).actions.variables.$post({ body })
      )
    ).catch((e) => {
      if (e.response.status !== 409) throw e;
    });

    await githubRepo.resetWebhook(app);

    for (let i = 30; i > 0; i -= 1) {
      const res = await fetch(
        `https://github.com/${GITHUB_OWNER}/${repoName}/blob/main/package.json`
      );
      if (res.status === 200) break;

      await setInterval(1000);
    }

    await githubApiClient.repos
      ._owner(GITHUB_OWNER)
      ._repo(repoName)
      .$patch({ body: { homepage: urls.site, default_branch: 'main' } });
  },
  createSchema: async (app: AppModel) => {
    const gitDiff = await llmRepo.initSchema(app);
    const branch: RemoteBranch = 'deus/db-schema';

    await localGitRepo.pushToRemote(app, gitDiff, branch);
    await githubUseCase.addGitBubble(app, branch, gitDiff);
  },
  createApiDef: async (app: AppModel) => {
    const localGit = await localGitRepo.getFiles(app, 'deus/db-schema');
    const gitDiff = await llmRepo.initApiDef(app, localGit);
    const branch: RemoteBranch = 'deus/api-definition';

    await localGitRepo.pushToRemote(app, gitDiff, branch);
    await githubUseCase.addGitBubble(app, branch, gitDiff);
  },
};
