import { useEffect, useRef, useState } from 'react';
import {
  Stack,
  Title,
  Text,
  Paper,
  Group,
  Button,
  ColorInput,
  NumberInput,
  FileButton,
  Image,
  ActionIcon,
  SimpleGrid,
} from '@mantine/core';
import { IconUpload, IconTrash, IconDeviceFloppy } from '@tabler/icons-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { api, AppSettings } from '../api/client';
import { logoSrc, readableText } from '../lib/theme';
import { MONEY_INPUT_BRL } from '../lib/money';

const SWATCHES = ['#ffffff', '#f8f9fa', '#1f2937', '#0b7285', '#2b8a3e', '#5f3dc4', '#c2255c', '#e8590c', '#228be6'];

const HEX_RE = /^#[0-9a-f]{6}$/i;
const COLOR_ERROR = 'Cor inválida. Use o formato #RRGGBB.';

// ColorInput that keeps what was typed and shows an inline error (instead of silently reverting on blur).
function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <ColorInput
      label={label}
      value={value}
      onChange={onChange}
      fixOnBlur={false}
      format="hex"
      swatches={SWATCHES}
      error={value.trim() !== '' && !HEX_RE.test(value) ? COLOR_ERROR : undefined}
    />
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function Settings() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['/settings'], queryFn: () => api.get<AppSettings>('/settings') });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['/settings'] });

  const [menuColor, setMenuColor] = useState('#ffffff');
  const [accentColor, setAccentColor] = useState('#228be6');
  const [bgColor, setBgColor] = useState('#f8f9fa');
  const [buttonColor, setButtonColor] = useState('#228be6');
  const [buttonHoverColor, setButtonHoverColor] = useState('#1c7ed6');
  const [hoverPreview, setHoverPreview] = useState(false);
  const [editWindowDays, setEditWindowDays] = useState<number | string>(20);
  const [previewWindowDays, setPreviewWindowDays] = useState<number | string>(30);
  const [minInstallmentValue, setMinInstallmentValue] = useState<number | string>(150);

  useEffect(() => {
    if (data) {
      setMenuColor(data.menuColor);
      setAccentColor(data.accentColor);
      setBgColor(data.bgColor);
      setButtonColor(data.buttonColor);
      setButtonHoverColor(data.buttonHoverColor);
      setEditWindowDays(data.editWindowDays);
      setPreviewWindowDays(data.previewWindowDays);
      setMinInstallmentValue(data.minInstallmentValue);
    }
  }, [data]);

  const saveInstallment = useMutation({
    mutationFn: () => api.put('/settings', { minInstallmentValue: Number(minInstallmentValue) || 0 }),
    onSuccess: () => {
      invalidate();
      notifications.show({ message: 'Parcelamento salvo', color: 'green' });
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });

  const saveWindows = useMutation({
    mutationFn: () =>
      api.put('/settings', {
        editWindowDays: Number(editWindowDays) || 0,
        previewWindowDays: Number(previewWindowDays) || 0,
      }),
    onSuccess: () => {
      invalidate();
      notifications.show({ message: 'Prazos salvos', color: 'green' });
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });

  // preview falls back to the last valid colour while the typed text is invalid
  const lastValidBtn = useRef('#228be6');
  const lastValidHover = useRef('#1c7ed6');
  if (HEX_RE.test(buttonColor)) lastValidBtn.current = buttonColor;
  if (HEX_RE.test(buttonHoverColor)) lastValidHover.current = buttonHoverColor;
  const previewColor = hoverPreview ? lastValidHover.current : lastValidBtn.current;
  const colorsValid = [menuColor, accentColor, bgColor, buttonColor, buttonHoverColor].every((c) => HEX_RE.test(c));
  const saveColors = useMutation({
    mutationFn: () =>
      api.put('/settings', { menuColor, accentColor, bgColor, buttonColor, buttonHoverColor }),
    onSuccess: () => {
      invalidate();
      notifications.show({ message: 'Aparência salva', color: 'green' });
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });

  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      const content = await fileToBase64(file);
      return api.post('/settings/logo', { content, mime: file.type || 'image/png' });
    },
    onSuccess: () => {
      invalidate();
      notifications.show({ message: 'Logo atualizado', color: 'green' });
    },
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });

  const removeLogo = useMutation({
    mutationFn: () => api.del('/settings/logo'),
    onSuccess: invalidate,
    onError: (e: Error) => notifications.show({ message: e.message, color: 'red' }),
  });

  const currentLogo = logoSrc(data);

  return (
    <Stack maw={640}>
      <div>
        <Title order={2}>Aparência</Title>
        <Text size="sm" c="dimmed">
          Personalize as cores do menu e do fundo e a logo do sistema. Aplica-se a todas as máquinas.
        </Text>
      </div>

      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="sm">
          Cores
        </Title>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <ColorField label="Cor do menu" value={menuColor} onChange={setMenuColor} />
          <ColorField label="Cor de destaque" value={accentColor} onChange={setAccentColor} />
          <ColorField label="Cor de fundo" value={bgColor} onChange={setBgColor} />
          <ColorField label="Cor dos botões" value={buttonColor} onChange={setButtonColor} />
          <ColorField label="Cor dos botões (hover)" value={buttonHoverColor} onChange={setButtonHoverColor} />
          <div>
            <Text size="sm" fw={500} mb={2}>
              Prévia
            </Text>
            <Button
              style={{
                backgroundColor: previewColor,
                color: readableText(previewColor),
              }}
              onMouseEnter={() => setHoverPreview(true)}
              onMouseLeave={() => setHoverPreview(false)}
            >
              {hoverPreview ? 'Botão (hover)' : 'Botão de exemplo'}
            </Button>
          </div>
        </SimpleGrid>
        <Group justify="flex-end" mt="md">
          <Button leftSection={<IconDeviceFloppy size={16} />} loading={saveColors.isPending} disabled={!colorsValid} onClick={() => saveColors.mutate()}>
            Salvar cores
          </Button>
        </Group>
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="sm">
          Prazos dos status
        </Title>
        <Text size="xs" c="dimmed" mb="sm">
          Dias para concluir as etapas com prazo (contratos únicos). Após o prazo, o contrato é marcado
          como “atrasado”.
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <NumberInput label="Em edição (dias)" min={0} value={editWindowDays} onChange={setEditWindowDays} />
          <NumberInput label="Enviado (dias)" min={0} value={previewWindowDays} onChange={setPreviewWindowDays} />
        </SimpleGrid>
        <Group justify="flex-end" mt="md">
          <Button leftSection={<IconDeviceFloppy size={16} />} loading={saveWindows.isPending} onClick={() => saveWindows.mutate()}>
            Salvar prazos
          </Button>
        </Group>
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="sm">
          Parcelamento
        </Title>
        <Text size="xs" c="dimmed" mb="sm">
          Valor mínimo de cada parcela. Define em quantas parcelas um contrato ou fatura pode ser dividido
          (ex.: com mínimo de R$ 150, um valor de R$ 600 aceita até 4 parcelas). Vale para novos
          parcelamentos; parcelas já geradas não mudam.
        </Text>
        <NumberInput
          label="Valor mínimo por parcela (R$)"
          {...MONEY_INPUT_BRL}
          fixedDecimalScale
          min={1}
          w={240}
          value={minInstallmentValue}
          onChange={setMinInstallmentValue}
        />
        <Group justify="flex-end" mt="md">
          <Button
            leftSection={<IconDeviceFloppy size={16} />}
            loading={saveInstallment.isPending}
            disabled={!(Number(minInstallmentValue) >= 1)}
            onClick={() => saveInstallment.mutate()}
          >
            Salvar parcelamento
          </Button>
        </Group>
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Title order={4} mb="sm">
          Logo
        </Title>
        <Group>
          <Paper withBorder p="xs" radius="md" style={{ width: 96, height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {currentLogo ? (
              <Image src={currentLogo} alt="logo" fit="contain" mah={48} />
            ) : (
              <Text size="xs" c="dimmed">
                sem logo
              </Text>
            )}
          </Paper>
          <FileButton accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={(f) => f && uploadLogo.mutate(f)}>
            {(props) => (
              <Button {...props} variant="light" leftSection={<IconUpload size={16} />} loading={uploadLogo.isPending}>
                {currentLogo ? 'Trocar logo' : 'Enviar logo'}
              </Button>
            )}
          </FileButton>
          {currentLogo && (
            <ActionIcon variant="subtle" color="red" title="Remover logo" onClick={() => removeLogo.mutate()}>
              <IconTrash size={18} />
            </ActionIcon>
          )}
        </Group>
        <Text size="xs" c="dimmed" mt="xs">
          Aparece ao lado do título, no topo do menu. Ideal uma imagem pequena (PNG/SVG).
        </Text>
      </Paper>
    </Stack>
  );
}
