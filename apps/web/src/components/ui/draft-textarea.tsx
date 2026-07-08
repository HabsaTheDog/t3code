"use client";

import { useCommitOnBlur } from "~/hooks/useCommitOnBlur";
import { Textarea, type TextareaProps } from "./textarea";

export type DraftTextareaProps = Omit<TextareaProps, "value" | "onChange" | "defaultValue"> & {
  readonly value: string;
  readonly onCommit: (next: string) => void;
};

/**
 * Textarea that keeps an in-progress edit local and persists it on blur.
 * Newlines remain normal editing input rather than committing the draft.
 */
export function DraftTextarea({ value, onCommit, ...rest }: DraftTextareaProps) {
  const bag = useCommitOnBlur<HTMLTextAreaElement>(value, onCommit, {
    commitOnEnter: false,
  });
  return <Textarea {...rest} {...bag} />;
}
