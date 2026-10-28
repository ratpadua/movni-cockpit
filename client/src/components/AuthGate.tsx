import { ReactNode } from 'react';
import { Center, Stack, Loader, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import Login from '../pages/Login';

// Gates the whole app on a live DB connection. The connection is opened by
// logging in (Login page); until /session reports connected, the app is blocked.
export default function AuthGate({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: ['/session'],
    queryFn: () => api.get<{ connected: boolean }>('/session'),
    retry: false,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });

  if (isLoading) {
    return (
      <Center h="100vh">
        <Stack align="center" gap="xs">
          <Loader />
          <Text c="dimmed">Carregando…</Text>
        </Stack>
      </Center>
    );
  }

  if (!data?.connected) return <Login />;
  return <>{children}</>;
}
