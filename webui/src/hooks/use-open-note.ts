import { useNavigate } from '@tanstack/react-router';
import type { AppSearch } from '@/lib/search';

export function useOpenNote(): (recordId: string | null) => void {
  const navigate = useNavigate();

  return (recordId: string | null) => {
    navigate({
      to: '.',
      search: (prev: AppSearch) => {
        const next: AppSearch = { ...prev };
        if (recordId) {
          next.note = recordId;
        } else {
          delete next.note;
        }
        return next;
      },
      replace: true,
    });
  };
}
