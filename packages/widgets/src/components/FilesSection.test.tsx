// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The Mandate Authors
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatBytes } from '../format.js';
import type { FileItem } from '../model.js';
import { FilesSection } from './FilesSection.js';

afterEach(cleanup);

const SHA = `sha256:${'ab'.repeat(32)}`;
const file = (over: Partial<FileItem> = {}): FileItem => ({
  pointer: '/image',
  id: '33333333-3333-4333-8333-333333333333',
  name: 'logo.png',
  mediaType: 'image/png',
  size: 2048,
  sha256: SHA,
  preview: 'image',
  available: true,
  ...over,
});
const source = (text = 'hello') => ({
  downloadUrl: (id: string) => `/dl/${id}`,
  imageUrl: (id: string) => `/img/${id}`,
  text: vi.fn(() => Promise.resolve({ text, truncated: false })),
});

describe('UI-2 APR-5 files section', () => {
  it('APR-5 without a source shows metadata, the full hash and no image or link', () => {
    const { container } = render(<FilesSection files={[file(), file({ id: '44444444-4444-4444-8444-444444444444', name: 'notes.txt', mediaType: 'text/plain', preview: 'text' })]} />);
    expect(screen.getByRole('heading', { name: 'Files sent with this call (2)' })).toBeTruthy();
    expect(screen.getByText('logo.png')).toBeTruthy();
    expect(screen.getByText('image/png')).toBeTruthy();
    expect(screen.getAllByText(formatBytes(2048)).length).toBe(2);
    expect(screen.getAllByText(SHA).length).toBe(2);
    expect(screen.getAllByText('Open the page to see the file.').length).toBe(2);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
  });

  it('APR-5 an image file renders an img from imageUrl and a Download link', () => {
    const { container } = render(<FilesSection files={[file()]} source={source()} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/img/33333333-3333-4333-8333-333333333333');
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('logo.png');
    expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toBe('/dl/33333333-3333-4333-8333-333333333333');
  });

  it('APR-5 SEC-5 a text file shows the fetched text with bidi characters escaped', async () => {
    const src = source('a‮b');
    const { container } = render(<FilesSection files={[file({ preview: 'text', mediaType: 'text/plain' })]} source={src} />);
    await waitFor(() => { expect(container.querySelector('pre')).not.toBeNull(); });
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toBe('a\\u202Eb');
    expect(pre?.textContent).not.toContain('‮');
  });

  it('APR-5 a truncated text preview says so', async () => {
    const src = { ...source(), text: vi.fn(() => Promise.resolve({ text: 'x', truncated: true })) };
    render(<FilesSection files={[file({ preview: 'text' })]} source={src} />);
    await screen.findByText('Showing the first 64 KB.');
  });

  it('APR-5 a file without preview shows only the Download link', () => {
    const { container } = render(<FilesSection files={[file({ preview: 'none' })]} source={source()} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('pre')).toBeNull();
    expect(screen.getByRole('link', { name: 'Download' })).toBeTruthy();
  });

  it('APR-5 an unavailable file reads the removal line and has no link', () => {
    const { container } = render(<FilesSection files={[file({ available: false })]} source={source()} />);
    expect(screen.getByText("The file's content was removed after the retention period.")).toBeTruthy();
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });
});
