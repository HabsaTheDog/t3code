"use client";

import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "./button";
import { Input } from "./input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";
import { cn } from "~/lib/utils";

interface SecretInputProps {
  readonly label: string;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly autoComplete?: string;
  readonly resetKey?: string | number;
  readonly className?: string;
  readonly inputClassName?: string;
  readonly noCapture?: boolean;
  readonly onValueChange: (value: string) => void;
}

function SecretInput({
  label,
  disabled = false,
  placeholder = "Enter secret",
  autoComplete = "new-password",
  resetKey,
  className,
  inputClassName,
  noCapture = true,
  onValueChange,
}: SecretInputProps) {
  const [value, setValue] = useState("");
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setValue("");
    setRevealed(false);
  }, [resetKey]);

  return (
    <div
      className={cn("ph-no-capture flex items-center gap-2 pt-3", className)}
      data-ph-no-capture={noCapture ? true : undefined}
    >
      <Input
        nativeInput
        type={revealed ? "text" : "password"}
        value={value}
        disabled={disabled}
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-label={label}
        className={inputClassName}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setValue(next);
          onValueChange(next);
        }}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              className="shrink-0"
              disabled={disabled}
              aria-label={revealed ? `Hide ${label}` : `Reveal ${label}`}
              onClick={() => setRevealed((current) => !current)}
            />
          }
        >
          {revealed ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
        </TooltipTrigger>
        <TooltipPopup side="top">{revealed ? "Hide secret" : "Reveal secret"}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

export { SecretInput };
