import { useState } from 'react';
import { DumbbellIcon } from './icons';
import { imageUrlForSlug } from '../services/exerciseDb';

interface ExerciseImageProps {
  slug?: string | null;
  alt: string;
  className?: string;
}

/**
 * Exercise thumbnail from the jsDelivr CDN (lazy-loaded). Falls back to a
 * dumbbell icon when there's no matched slug or the image fails to load — so a
 * missing image is always graceful (design §4).
 */
export function ExerciseImage({ slug, alt, className }: ExerciseImageProps) {
  const url = imageUrlForSlug(slug);
  const [failed, setFailed] = useState(false);

  if (!url || failed) {
    return (
      <div
        className={`ex-thumb ex-thumb--fallback${className ? ` ${className}` : ''}`}
        aria-hidden="true"
      >
        <DumbbellIcon />
      </div>
    );
  }

  return (
    <img
      className={`ex-thumb${className ? ` ${className}` : ''}`}
      src={url}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
}
