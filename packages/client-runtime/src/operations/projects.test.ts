import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, type RepositoryIdentity } from "@t3tools/contracts";

import {
  clusterCloneEnvironmentIds,
  findExistingAddProject,
  getCloneDestinationForPickedFolder,
  getCloneDestinationPath,
  getCloneDirectoryLeafName,
  getCloneDirectoryName,
  getCloneDirectoryPath,
  getAddProjectInitialQuery,
  getClusterCloneDestinationPath,
  getDefaultCloneDestinationPath,
  getDefaultCloneUrl,
  githubIncompleteOwnerRepositoryMessage,
  normalizePastedCloneUrl,
  projectCloneRemoteUrl,
  sortAddProjectProviderSources,
} from "./projects.ts";
import { ClusterConnectionTarget, PrimaryConnectionTarget } from "../connection/model.ts";
import type { EnvironmentProject } from "../state/models.ts";
import { isFilesystemBrowseQuery } from "../state/projects.ts";

describe("add project shared logic", () => {
  it("starts the Add Project picker on a browsable path for a relative base directory", () => {
    expect(isFilesystemBrowseQuery(getAddProjectInitialQuery("Desktop/dev"))).toBe(true);
    expect(getAddProjectInitialQuery("Desktop/dev")).toBe("~/Desktop/dev/");
    expect(getAddProjectInitialQuery("/srv/code")).toBe("/srv/code/");
    expect(getAddProjectInitialQuery("~")).toBe("~/");
    expect(getAddProjectInitialQuery("./work")).toBe("./work/");
    expect(getAddProjectInitialQuery("C:\\dev")).toBe("C:\\dev\\");
  });

  it("offers only GitHub until other hosts are turned on", () => {
    const ready = () => ({ ready: true, hint: null });
    expect(sortAddProjectProviderSources(ready, {})).toEqual(["github"]);
    expect(sortAddProjectProviderSources(ready, { gitlab: true, github: false })).toEqual([
      "gitlab",
    ]);
  });

  it("asks for a repository name when GitHub input is only an owner path", () => {
    const github = SourceControlProviderKind.make("github");
    expect(githubIncompleteOwnerRepositoryMessage(github, "pingdotgg/")).toBe(
      "Enter the full owner/repository name.",
    );
    expect(githubIncompleteOwnerRepositoryMessage(github, "  pingdotgg//  ")).toBe(
      "Enter the full owner/repository name.",
    );
    expect(githubIncompleteOwnerRepositoryMessage(github, "mona-cat_octo/")).toBe(
      "Enter the full owner/repository name.",
    );

    for (const input of [
      "pingdotgg/t3code",
      "mona-cat_octo/repo",
      "pingdotgg",
      "https://github.com/pingdotgg/t3code.git",
      "git@github.com:pingdotgg/t3code.git",
    ]) {
      expect(githubIncompleteOwnerRepositoryMessage(github, input)).toBeNull();
    }
    expect(
      githubIncompleteOwnerRepositoryMessage(SourceControlProviderKind.make("gitlab"), "group/"),
    ).toBeNull();
    expect(githubIncompleteOwnerRepositoryMessage("url", "owner/")).toBeNull();
    expect(
      githubIncompleteOwnerRepositoryMessage(SourceControlProviderKind.make("forgejo"), "owner/"),
    ).toBeNull();
  });

  it("routes owner/repository shorthand to GitHub over HTTPS", () => {
    expect(normalizePastedCloneUrl("imputnet/helium")).toBe(
      "https://github.com/imputnet/helium.git",
    );
    expect(normalizePastedCloneUrl("  pingdotgg/t3code  ")).toBe(
      "https://github.com/pingdotgg/t3code.git",
    );
  });

  it("keeps explicit clone URLs and local paths unchanged", () => {
    expect(normalizePastedCloneUrl("https://gitlab.com/group/project.git")).toBe(
      "https://gitlab.com/group/project.git",
    );
    expect(normalizePastedCloneUrl("git@github.com:owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
    expect(normalizePastedCloneUrl("group/subgroup/project")).toBe("group/subgroup/project");
    expect(normalizePastedCloneUrl("/srv/git/repo.git")).toBe("/srv/git/repo.git");
    for (const gitlabProject of [
      "https://gitlab.com/acme/tools/src/branch/worker.git",
      "https://scm.example.test/acme/tools/src/branch/worker.git",
      "https://scm.example.test/acme/tools/src/branch/worker",
      "https://scm.example.test/team/repo/src/branch/main/-/README.md",
      "https://forgejo.example.test/a/b/src/branch/mount/team/repo.git",
    ]) {
      expect(normalizePastedCloneUrl(gitlabProject)).toBe(gitlabProject);
    }
  });

  it("clones the repository when given a page URL copied from the browser", () => {
    for (const [pageUrl, pageRoute, repository] of [
      ["https://github.com/pingdotgg/t3code/tree/main", "/tree/", "t3code"],
      ["https://gitlab.com/gitlab-org/gitlab-runner/-/tree/main", "/-/", "gitlab-runner"],
      ["https://git.cafe/pingdotgg/t3code/tree/main", "/tree/", "t3code"],
      ["https://gitlab.example.test/g/p/-/blob/main/src/branch/x", "/-/", "p"],
      ["https://code.company.test/g/p/-/tree/main", "/-/", "p"],
      ["https://github.com/pingdotgg/t3code/tree/release.git", "/tree/", "t3code"],
    ] as const) {
      const cloneUrl = normalizePastedCloneUrl(pageUrl);
      expect(cloneUrl).not.toContain(pageRoute);
      expect(getCloneDirectoryName(cloneUrl)).toBe(repository);
    }
    expect(
      normalizePastedCloneUrl("https://alice:example@bitbucket.org/workspace/repo/src/master/"),
    ).toBe("https://alice:example@bitbucket.org/workspace/repo");
  });

  it("uses HTTPS for repositories selected through a provider", () => {
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("github"),
        url: "https://github.com/imputnet/helium",
        sshUrl: "git@github.com:imputnet/helium.git",
      }),
    ).toBe("https://github.com/imputnet/helium");
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("forgejo"),
        url: "https://forgejo.example.test:8443/owner/repo.git",
        sshUrl: "ssh://git@forgejo.example.test:2222/owner/repo.git",
      }),
    ).toBe("https://forgejo.example.test:8443/owner/repo.git");
  });

  it("derives the clone folder name from any pasted clone URL", () => {
    expect(getCloneDirectoryName("https://github.com/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo/")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("ssh://git@github.com:22/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://user@bitbucket.org/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://dev.azure.com/org/project/_git/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo.git?ref=main#readme")).toBe("repo");
    expect(getCloneDirectoryName("/srv/git/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("C:\\src\\repo.git")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:repo.git")).toBe("repo");
    expect(getCloneDirectoryName("  https://github.com/owner/repo.git  ")).toBe("repo");
  });

  it("lays clone folders out like ghq only when asked, and only when the URL is safe", () => {
    expect(getCloneDirectoryPath("git@github.com:owner/repo.git", false)).toBe("repo");
    expect(getCloneDirectoryPath("git@github.com:owner/repo.git", true)).toBe(
      "github.com/owner/repo",
    );
    expect(getCloneDirectoryPath("ssh://git@gitlab.com:2222/group/sub/repo.git", true)).toBe(
      "gitlab.com/group/sub/repo",
    );
    expect(getCloneDirectoryPath("https://github.com/owner/../../repo", true)).toBe("repo");
    expect(getCloneDirectoryPath("/srv/git/repo.git", true)).toBe("repo");
    expect(
      getCloneDirectoryPath(
        "git@ssh.dev.azure.com:v3/org/Project/My%20Repo",
        false,
        "Project/My Repo",
      ),
    ).toBe("My Repo");
    expect(
      getCloneDirectoryLeafName(
        "git@ssh.dev.azure.com:v3/org/Project/My%20Repo",
        true,
        "Project/My Repo",
      ),
    ).toBe("My%20Repo");
    expect(
      getCloneDestinationPath(
        "C:\\Users\\me\\ghq",
        getCloneDirectoryPath("git@github.com:owner/repo.git", true),
      ),
    ).toBe("C:\\Users\\me\\ghq\\github.com\\owner\\repo");
  });

  it("keeps a numeric repository name that sits on a path", () => {
    expect(getCloneDirectoryName("https://github.com/acme/123.git")).toBe("123");
    expect(getCloneDirectoryName("https://github.com/acme/123")).toBe("123");
    expect(getCloneDirectoryName("git@github.com:acme/123.git")).toBe("123");
  });

  it("resolves a native-picker folder like an in-app clone selection", () => {
    const pick = (pickedPath: string, caseSensitive = true) =>
      getCloneDestinationForPickedFolder({
        pickedPath,
        cloneDirectoryName: "repo",
        caseSensitive,
      });

    expect(pick("/Users/me/code")).toBe("/Users/me/code/repo");
    expect(pick("/Users/me/code/")).toBe("/Users/me/code/repo");
    expect(pick("/Users/me/repo")).toBe("/Users/me/repo/");
    expect(pick("/Users/me/Repo")).toBe("/Users/me/Repo/repo");
    expect(pick("C:\\Projects\\Repo", false)).toBe("C:\\Projects\\Repo\\");
    expect(pick("C:\\Projects", false)).toBe("C:\\Projects\\repo");
    expect(pick("/")).toBe("/repo");
  });

  it("finds existing projects by normalized path in the target environment", () => {
    const env = EnvironmentId.make("env");
    const other = EnvironmentId.make("other");
    const projects: EnvironmentProject[] = [
      {
        environmentId: other,
        id: ProjectId.make("same-path-other-env"),
        title: "Other",
        workspaceRoot: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        environmentId: env,
        id: ProjectId.make("project"),
        title: "Repo",
        workspaceRoot: "/repo/",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
    ];

    expect(findExistingAddProject({ projects, environmentId: env, path: "/repo" })?.id).toBe(
      "project",
    );
  });
});

describe("cluster clone targets", () => {
  const HOST = EnvironmentId.make("host");
  const identity: RepositoryIdentity = {
    canonicalKey: "github.com/t3tools/t3code",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "git@github.com:t3tools/t3code.git",
    },
  };
  const host = {
    environmentId: HOST,
    entry: {
      enabled: true,
      target: new PrimaryConnectionTarget({
        environmentId: HOST,
        label: "Studio",
        httpBaseUrl: "http://studio",
        wsBaseUrl: "ws://studio",
      }),
    },
    connection: { phase: "connected" as const },
  };
  const member = (
    id: string,
    overrides: {
      status?: ClusterConnectionTarget["status"];
      enabled?: boolean;
      phase?: "connected" | "offline";
      hostEnvironmentId?: EnvironmentId;
    } = {},
  ) => ({
    environmentId: EnvironmentId.make(id),
    entry: {
      enabled: overrides.enabled ?? true,
      target: new ClusterConnectionTarget({
        environmentId: EnvironmentId.make(id),
        label: id,
        hostEnvironmentId: overrides.hostEnvironmentId ?? HOST,
        hostLabel: "Studio",
        hostConnectionKey: null,
        status: overrides.status ?? "online",
        statusDetail: null,
      }),
    },
    connection: { phase: overrides.phase ?? "connected" },
  });
  const environments = [
    host,
    member("box"),
    member("offline", { status: "offline" }),
    member("revoked", { status: "revoked" }),
    member("disconnected", { phase: "offline" }),
    member("disabled", { enabled: false }),
    member("has-project"),
    member("other-cluster", { hostEnvironmentId: EnvironmentId.make("other-host") }),
  ];
  const targets = (projectEnvironmentId: EnvironmentId) =>
    clusterCloneEnvironmentIds({
      project: { environmentId: projectEnvironmentId },
      environments,
      hasProject: new Set([EnvironmentId.make("has-project")]),
    });

  it("offers online members of the project machine's cluster that lack the project", () => {
    expect(targets(HOST)).toEqual(["box"]);
  });

  it("offers the main host and the other members for a project on a member", () => {
    expect(targets(EnvironmentId.make("box"))).toEqual(["host"]);
    expect(targets(EnvironmentId.make("has-project"))).toEqual(["host", "box"]);
  });

  it("has no clone remote for a project without a remote it can group by", () => {
    expect(projectCloneRemoteUrl({ repositoryIdentity: null })).toBeNull();
    expect(
      projectCloneRemoteUrl({
        repositoryIdentity: { ...identity, origin: { canonicalKey: "github.com/julius/t3code" } },
      }),
    ).toBeNull();
  });

  it("clones from the origin remote that the project groups by", () => {
    expect(projectCloneRemoteUrl({ repositoryIdentity: identity })).toBe(
      "git@github.com:t3tools/t3code.git",
    );
    expect(
      projectCloneRemoteUrl({
        repositoryIdentity: {
          ...identity,
          origin: {
            canonicalKey: "github.com/julius/t3code",
            remoteUrl: "https://github.com/julius/t3code.git",
          },
        },
      }),
    ).toBe("https://github.com/julius/t3code.git");
  });

  it("clones into the machine's Add Project folder by default", () => {
    const url = "git@github.com:t3tools/t3code.git";
    expect(getDefaultCloneDestinationPath(url, undefined)).toBe("~/t3code");
    expect(
      getDefaultCloneDestinationPath(url, {
        addProjectBaseDirectory: "/srv",
        ghqCloneLayout: true,
      }),
    ).toBe("/srv/github.com/t3tools/t3code");
  });

  it.each([
    ["/root/git/tau", "/root", "~/git/tau"],
    ["/Users/me/git/tau", "/Users/me/", "~/git/tau"],
    ["C:\\Users\\me\\git\\tau", "C:\\Users\\me", "~/git/tau"],
    ["/root2/tau", "/root", "/root2/tau"],
    ["/srv/tau", "/root", "/srv/tau"],
    ["/root/git/tau", undefined, "~/tau"],
  ])("clones %s from home %s to %s on another cluster machine", (root, home, expected) => {
    expect(
      getClusterCloneDestinationPath({
        remoteUrl: "git@github.com:me/tau.git",
        sourceWorkspaceRoot: root,
        sourceHomeDirectory: home,
        targetSettings: undefined,
      }),
    ).toBe(expected);
  });
});
