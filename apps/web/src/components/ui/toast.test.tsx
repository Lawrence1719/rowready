import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Toaster, useToasts } from './toast';

function Harness() {
  const { toasts, notify, dismiss, dismissAll } = useToasts();
  return <><button onClick={() => notify('Saved', 'success', 'edit')}>Save</button><button onClick={() => notify('Failed', 'error')}>Fail</button><button onClick={dismissAll}>Clear</button><Toaster toasts={toasts} onDismiss={dismiss} /></>;
}
function advance(ms: number) { act(() => vi.advanceTimersByTime(ms)); }
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('auto-dismisses after the reading period, then retains the exit animation before removal', () => {
  render(<Harness />);
  fireEvent.click(screen.getByText('Save'));
  advance(4199);
  expect(screen.getByTestId('notification-toast')).toHaveAttribute('data-state', 'open');
  advance(1);
  expect(screen.getByTestId('notification-toast')).toHaveAttribute('data-state', 'closed');
  advance(180);
  expect(screen.queryByTestId('notification-toast')).not.toBeInTheDocument();
});

it('repeating the same action restarts its lifetime without an old timer dismissing it', () => {
  render(<Harness />);
  fireEvent.click(screen.getByText('Save'));
  advance(4000);
  fireEvent.click(screen.getByText('Save'));
  expect(screen.getAllByTestId('notification-toast')).toHaveLength(1);
  advance(4000);
  expect(screen.getByTestId('notification-toast')).toHaveAttribute('data-state', 'open');
  advance(200);
  expect(screen.getByTestId('notification-toast')).toHaveAttribute('data-state', 'closed');
  advance(180);
  expect(screen.queryByTestId('notification-toast')).not.toBeInTheDocument();
});

it('pauses on hover and resumes the remaining time when the pointer leaves', () => {
  render(<Harness />);
  fireEvent.click(screen.getByText('Save'));
  advance(2000);
  fireEvent.mouseEnter(screen.getByRole('list', { name: 'Notifications' }));
  advance(9000);
  expect(screen.getByTestId('notification-toast')).toHaveAttribute('data-state', 'open');
  fireEvent.mouseLeave(screen.getByRole('list', { name: 'Notifications' }));
  advance(2200);
  expect(screen.getByTestId('notification-toast')).toHaveAttribute('data-state', 'closed');
});

it('allows longer error reading time and manual dismissal', () => {
  render(<Harness />);
  fireEvent.click(screen.getByText('Fail'));
  advance(5000);
  expect(screen.getByTestId('notification-toast')).toHaveAttribute('data-state', 'open');
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
  expect(screen.getByTestId('notification-toast')).toHaveAttribute('data-state', 'closed');
  advance(180);
  expect(screen.queryByTestId('notification-toast')).not.toBeInTheDocument();
});

it('does not leave future notifications paused after dismissing a focused notification', () => {
  render(<Harness />);
  fireEvent.click(screen.getByText('Save'));
  const close = screen.getByRole('button', { name: 'Dismiss notification' });
  act(() => close.focus());
  advance(7000);
  expect(screen.getByTestId('notification-toast')).toHaveAttribute('data-state', 'open');
  fireEvent.click(close);
  advance(180);
  fireEvent.click(screen.getByText('Save'));
  advance(4200);
  expect(screen.getByTestId('notification-toast')).toHaveAttribute('data-state', 'closed');
});
