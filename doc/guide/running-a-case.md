# Running a Case

The **Run case** button in the Problemtype sidebar generates the Kratos input
files and starts the solver. Every run is tracked in a **Kratos Runs** view in
the Explorer.

## What the view shows

One row per run, newest first:

| | |
|---|---|
| **running · 1m 12s · step 34** | live, with the latest step written to `vtk_output/` |
| **finished · 2m 14s** | exited cleanly |
| **failed · 0m 04s · exit 1** | exited non-zero — expand the row for the code, or open the log |
| **cancelled** | you stopped it |
| **detached** | running, but not tracked — see below |
| **orphaned** | it was live when the window closed, and no exit code was recorded |

Expand a row for the case folder, the output summary, the log, and the exit code
when there is one. Hovering shows the exact command, the process id and the last
line the solver printed.

## Stopping

**Stop** interrupts the solver so it can finish closing the file it is writing.
Anything already written to `vtk_output/` is kept — nothing is deleted.

Because an interrupted solver can leave a half-written final file, **Open
results** for a run that did not finish cleanly opens the last *complete* step
rather than the newest one.

::: warning Windows has no graceful interrupt
On Windows the process is terminated immediately, so the final result file is
more likely to be incomplete. The confirmation dialog says so.
:::

## Tracked or interactive

By default the solver runs as a child process and its output goes to an Output
channel. That is what makes a real exit code, live progress and a working Stop
possible — and it means a wrong `kratos.pythonPath` is reported as a failed run
naming the problem, rather than a "command not found" scrolling past.

Set `kratos.run.launchMode` to `terminal` if you need an interactive shell (a
password prompt, a `conda activate` in your rc file). The run still appears in
the view, but marked **detached**: a terminal cannot tell the extension when the
solver exits, so its status is not tracked and no exit code is claimed.

## Closing the window

Runs outlive the preview that started them, but not the window. By default,
closing or reloading stops them (`kratos.run.stopOnWindowClose`) — a solver left
behind would otherwise keep running with nothing able to report on it.

Turn that off and runs are detached instead, surviving the window. When the
extension next starts it re-reads what it left behind and reports it honestly:

- the process is gone and no exit code was recorded → **orphaned**
- the process id is still alive → **detached**, *"may still be running"*

It never says **running**. Process ids get reused, so a live id is not proof
that it is still *your* solver, and the viewer does not claim a liveness it
cannot verify.

## Two cases in one folder

The generated `ProjectParameters.json`, `MainKratos.py` and `vtk_output/` live
next to the mesh with fixed names, so two meshes in the same folder genuinely
share them. Running a second case in a folder where one is already live warns you
and names the other mesh; re-running the *same* case while it is live offers to
stop the existing run first, since generating has just rewritten the files it was
reading.

## Progress

Progress is the latest step in `vtk_output/`, not a parse of the solver's log.
The generated `MainKratos.py` prints nothing of its own — every line comes from
Kratos' own logger in a format this extension does not control, and it is flushed
on a timer, so a progress bar built on it would stall and then jump. The output
directory is the honest signal, and it works the same for a tracked run, a
terminal run, and a run adopted after a reload.

## Headless

Agents drive the same runs through three [MCP tools](/guide/development), which
meet the editor on the filesystem: they read and write the same
`<stem>.kratosrun.json` beside the mesh, so a run started on either side is
visible from both.

- **`case_run`** generates the case files and starts the solver.
- **`case_status`** reports where it has got to.
- **`case_stop`** stops it.

The server never *owns* a run, and that shapes how `case_run` behaves. Its
stdout is the protocol channel and it exits with its client, so the solver is
always started **detached**, with its output appended to
`<stem>.kratosrun.log` — it outlives the server by construction, and **Show
output** in the Kratos Runs view opens that same file.

`waitSeconds` (default 10) is how long the call blocks for the solver to
finish. A short case comes back with its exit code. A real one does not, and
that is not an error: the call returns `running` with the pid and the log path,
the solve carries on, and you poll `case_status`. The budget is small on
purpose — the only thing that can time a call out is the *client's* own request
timeout, a number the server cannot see, so it hands off early rather than
gambling on it.

One asymmetry worth knowing, because it looks like a bug and is not: the same
live run reads `running` from `case_run` and `detached` from `case_status`.
`case_run` holds the process handle and saw it start; `case_status` has only a
pid, and pids are reused, so it will not claim more than it can verify.

Once the server exits, nothing is left to record how a detached run ended — so
`case_status` reports it `orphaned` rather than inventing an exit code. The
results in `vtk_output/` are of course still there.
