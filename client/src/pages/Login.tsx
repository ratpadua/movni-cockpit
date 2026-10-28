import { useState } from 'react';
import {
  Center,
  Paper,
  Stack,
  Title,
  Text,
  TextInput,
  PasswordInput,
  Button,
  Alert,
} from '@mantine/core';
import { IconLock, IconAlertCircle } from '@tabler/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

// The DB credentials ARE the app login: a successful login opens the database
// connection on the local server; only then does the app load.
export default function Login() {
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => api.post('/login', { username, password }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/session'] }),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (username && password) login.mutate();
  };

  return (
    <Center h="100vh" p="md">
      <Paper withBorder radius="md" p="xl" w={380}>
        <form onSubmit={submit}>
          <Stack>
            <div style={{ textAlign: 'center' }}>
              <Title order={3}>Movni Cockpit</Title>
              <Text size="sm" c="dimmed">
                Entre com as credenciais do banco de dados
              </Text>
            </div>

            {login.isError && (
              <Alert color="red" variant="light" icon={<IconAlertCircle size={16} />}>
                {(login.error as Error).message}
              </Alert>
            )}

            <TextInput
              label="Usuário"
              value={username}
              onChange={(e) => setUsername(e.currentTarget.value)}
              autoFocus
              required
            />
            <PasswordInput
              label="Senha"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              required
            />
            <Button
              type="submit"
              leftSection={<IconLock size={16} />}
              loading={login.isPending}
              disabled={!username || !password}
            >
              Entrar
            </Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  );
}
