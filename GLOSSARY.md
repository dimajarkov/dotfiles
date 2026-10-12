# Coding-agent review workflow

These terms distinguish the human workflow from internal harness and terminal lifecycles.

## Language

**Response**:
The work performed for one user request, including its tools, retries, and automatic continuations.
When Pi's explicit `all` queue mode intentionally batches requests into one response, the review records that group and every member's provenance.
_Avoid_: Internal assistant turn, tool cycle

**Review task**:
A deliberately bounded sequence of responses whose observed changes can be reviewed cumulatively.
A new review task begins only through an explicit action.

**Review**:
An immutable view of the repository changes observed during a response or review task.
It is not proof that one writer authored every change.

**Native session**:
The original coding-agent conversation, independent of where its terminal pane is located and whether the conversation is currently running.
_Avoid_: Pane, destination terminal

**Human note**:
Free-form feedback attached to a specific reviewed code context.
Its intent may be a change request, clarification, handoff, or another instruction.

**Feedback batch**:
An explicitly submitted, immutable collection of human note revisions and their original review context.

**Admission receipt**:
Evidence that the original native session accepted a feedback batch into its input queue.
It does not establish processing, successful completion, or resolution of any note.
