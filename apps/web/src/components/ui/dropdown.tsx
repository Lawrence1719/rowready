import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface DropdownProps {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly DropdownOption[];
  'aria-label': string;
  disabled?: boolean;
  className?: string;
  id?: string;
  placeholder?: string;
}

export function Dropdown({
  value,
  onValueChange,
  options,
  'aria-label': ariaLabel,
  disabled,
  className,
  id,
  placeholder,
}: DropdownProps) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        id={id}
        className={cn('dropdown-trigger', className)}
        aria-label={ariaLabel}
      >
        <SelectPrimitive.Value className="dropdown-value" placeholder={placeholder} />
        <SelectPrimitive.Icon asChild>
          <ChevronDown className="dropdown-chevron" aria-hidden="true" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className="dropdown-content"
          position="popper"
          align="start"
          sideOffset={5}
          collisionPadding={8}
        >
          <SelectPrimitive.ScrollUpButton className="dropdown-scroll-button">
            <ChevronUp aria-hidden="true" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="dropdown-viewport">
            {options.map((option) => (
              <SelectPrimitive.Item
                key={option.value}
                className="dropdown-item"
                value={option.value}
                disabled={option.disabled}
                textValue={option.label}
              >
                <SelectPrimitive.ItemText className="dropdown-item-label">
                  {option.label}
                </SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator className="dropdown-indicator">
                  <Check aria-hidden="true" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="dropdown-scroll-button">
            <ChevronDown aria-hidden="true" />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
