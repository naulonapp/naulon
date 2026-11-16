/**
 * The `paper.notice` event: a paper a reader was served text from has since been retracted,
 * withdrawn, corrected or flagged with an expression of concern.
 *
 * The host that served the text is the only party that knows who holds it, so it is the one that
 * tells. The same `PaperNotice` object reaches a reader two ways: inside the `data` of a signed
 * `paper.notice` webhook, and in-band on the reader's next tool call. Both carry the passages the
 * reader was served, named by the sentence indexes their receipt already used, so an agent can find
 * the sentences in its own output that rest on them.
 *
 * Like the envelope, every object here is open: an added field never fails a parse.
 */
import { z } from "zod";

/** The kinds of notice, most severe first. A correction is reported as a correction, never as a
 *  retraction. */
export const PAPER_NOTICE_TYPES = ["retraction", "withdrawal", "concern", "correction"] as const;
export type PaperNoticeType = (typeof PAPER_NOTICE_TYPES)[number];

/** Who published the notice. */
export const PAPER_NOTICE_SOURCES = ["publisher", "retraction-watch", "openalex"] as const;

/** One text version the reader was served from, and which of its sentences. */
export const servedTextSchema = z
  .object({
    /** The text root of the version served: the same value a read receipt names. */
    textRoot: z.string().min(1),
    /** Sentence indexes served from that version, ascending. The numbering of `quotes[].index`. */
    sentences: z.array(z.number().int().nonnegative()),
    /** True when more sentences were served than the host keeps a record of. */
    more: z.boolean(),
  })
  .loose();

/** A readable paper that engages the noticed one, offered as what to read instead. */
export const insteadSchema = z
  .object({
    key: z.string().min(1),
    title: z.string(),
    /** The paper's page on the host. */
    page: z.string().url(),
    /** The licence code of the readable copy, when the host knows it. */
    licence: z.string().nullable(),
    /** e.g. `systematic_review`, `meta_analysis`, `rct`, `review`. */
    studyType: z.string().nullable(),
    year: z.number().int().nullable(),
  })
  .loose();

export const paperNoticeSchema = z
  .object({
    /** Stable for one notice on one paper. Dedupe on this. */
    id: z.string().min(1),
    paper: z.object({ key: z.string().min(1), title: z.string(), page: z.string().url() }).loose(),
    /** Open on purpose: a host may add a kind before a reader's parser knows it. */
    type: z.string().min(1),
    /** The date on the notice itself (`YYYY-MM-DD`), when the source gives one. */
    date: z.string().nullable(),
    /** ISO time the host first saw the notice. Notices are ordered by it. */
    seenAt: z.string().min(1),
    source: z.string().min(1),
    /** The DOI of the notice, when it has one. */
    doi: z.string().nullable(),
    served: z.array(servedTextSchema),
    instead: z.array(insteadSchema),
  })
  .loose();

export type PaperNotice = z.infer<typeof paperNoticeSchema>;

/** The `data` of a `paper.notice` webhook: the notices in this delivery, oldest first, and how many
 *  more are due after them. */
export const paperNoticeDataSchema = z
  .object({
    notices: z.array(paperNoticeSchema).min(1),
    more: z.number().int().nonnegative(),
  })
  .loose();

export type PaperNoticeData = z.infer<typeof paperNoticeDataSchema>;
