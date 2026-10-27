---
title: Repository-Free Task Workspaces
summary: Stable task directories for projects without a configured repository
---

New ordinary tasks in projects without a configured workspace use private task
directories. Shared and isolated workspace modes both select these directories.
Each directory belongs to one company and task:

```text
~/.paperclip/instances/default/isolated-workspaces/<company-id>/<issue-id>
```

The path honors `PAPERCLIP_HOME` and `PAPERCLIP_INSTANCE_ID`.
Each task retains its files across turns and agent reassignment.
The directory needs no Git repository.
New recurring tasks do not inherit the project default directory or another
task's files. Their execution workspace records identify the owning task.

Explicit workspace bindings, repository strategies, branch requests, and setup
hooks retain their existing checks. The `agent_default` mode retains adapter
workspace selection. Code tasks still need an authorized repository configuration.
Paperclip does not infer a repository from task text.

Existing task sessions retain their previous selection path.
This change does not move or remove their files.
Projectless tasks retain their existing workspace checks, including native
run-ID bindings and legacy restart checkpoints without workspace IDs.

Recovery can reuse a task directory only through its owned execution workspace
binding. Native recovery must use the directory in its saved execution input.
A mismatched binding fails workspace validation.

For verification, use the heartbeat repository-free workspace tests.
They cover a foreign source issue and a non-Git project default directory.
They also check repeat runs, saved sessions, configured Git work, and projectless
workspace checks. These tests use temporary files and an isolated test database.
