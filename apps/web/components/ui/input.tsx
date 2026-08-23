import * as React from "react";
import { cn } from "../../lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "flex h-8 w-full rounded-none border border-border bg-black px-3 py-2 text-xs font-mono outline-none focus-visible:border-neon-green focus-visible:ring-0",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };
