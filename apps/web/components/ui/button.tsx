import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-sm text-xs font-mono uppercase tracking-wide font-medium transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neon-green disabled:opacity-50 disabled:pointer-events-none",
  {
    variants: {
      variant: {
        default: "bg-ink text-paper hover:bg-white",
        outline: "border border-border text-muted-foreground hover:text-ink hover:border-ink",
        ghost: "text-ink hover:bg-white/5",
        accent: "bg-neon-green text-black hover:bg-neon-green/90 shadow-glow"
      },
      size: {
        sm: "h-9 px-3",
        md: "h-10 px-4",
        lg: "h-11 px-6"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "md"
    }
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
  VariantProps<typeof buttonVariants> { }

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = "Button";

export { Button };
