import { AppShell, Group, NavLink, Text, Badge, Image, ActionIcon, Tooltip, Burger } from '@mantine/core';
import {
  IconDashboard,
  IconUsers,
  IconBriefcase,
  IconCash,
  IconFileText,
  IconBuildingBank,
  IconReportAnalytics,
  IconTemplate,
  IconPalette,
  IconTags,
  IconSettings,
  IconLogout,
} from '@tabler/icons-react';
import { useEffect } from 'react';
import { useDisclosure, useMediaQuery } from '@mantine/hooks';
import { Routes, Route, NavLink as RouterNavLink, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, AppSettings } from './api/client';
import { readableText, logoSrc, hexToRgba } from './lib/theme';
import Dashboard from './pages/Dashboard';
import Customers from './pages/Customers';
import CustomerDetail from './pages/CustomerDetail';
import Services from './pages/Services';
import Payments from './pages/Payments';
import Contracts from './pages/Contracts';
import ContractDetail from './pages/ContractDetail';
import BankImport from './pages/BankImport';
import Templates from './pages/Templates';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import Categories from './pages/Categories';

type NavChild = { to: string; label: string; icon: any };
type NavItem = { to?: string; label: string; icon: any; children?: NavChild[] };

const NAV: NavItem[] = [
  { to: '/', label: 'Painel', icon: IconDashboard },
  { to: '/services', label: 'Serviços', icon: IconBriefcase },
  { to: '/customers', label: 'Clientes', icon: IconUsers },
  { to: '/contracts', label: 'Contratos', icon: IconFileText },
  {
    label: 'Financeiro',
    icon: IconCash,
    to: '/payments',
    children: [
      { to: '/payments', label: 'Fluxo de Caixa', icon: IconCash },
      { to: '/bank', label: 'Extratos bancários', icon: IconBuildingBank },
    ],
  },
  { to: '/reports', label: 'Relatórios', icon: IconReportAnalytics },
  {
    label: 'Configurações',
    icon: IconSettings,
    to: '/categories',
    children: [
      { to: '/categories', label: 'Categorias', icon: IconTags },
      { to: '/templates', label: 'Modelos', icon: IconTemplate },
      { to: '/settings', label: 'Aparência', icon: IconPalette },
    ],
  },
];

const DEFAULTS: AppSettings = {
  menuColor: '#ffffff',
  accentColor: '#228be6',
  bgColor: '#f8f9fa',
  buttonColor: '#228be6',
  buttonHoverColor: '#1c7ed6',
  editWindowDays: 20,
  previewWindowDays: 30,
  minInstallmentValue: 150,
  logo: null,
  logoMime: null,
};

export default function App() {
  const location = useLocation();
  const [navOpened, { toggle: toggleNav, close: closeNav }] = useDisclosure(false);
  // close the mobile drawer whenever the route changes
  useEffect(() => {
    closeNav();
  }, [location.pathname, closeNav]);
  // ...and when the viewport grows to the desktop layout
  const isDesktop = useMediaQuery('(min-width: 62em)');
  useEffect(() => {
    if (isDesktop) closeNav();
  }, [isDesktop, closeNav]);
  const qc = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api.post('/logout', {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['/session'] }),
  });
  const { data: settings } = useQuery({
    queryKey: ['/settings'],
    queryFn: () => api.get<AppSettings>('/settings'),
  });
  const s = settings ?? DEFAULTS;
  const menuText = readableText(s.menuColor);
  const accentText = readableText(s.accentColor);
  const logo = logoSrc(settings);

  // Apply custom button colors app-wide across every Mantine Button variant.
  const bc = s.buttonColor;
  const bh = s.buttonHoverColor;
  const hov = ':not(:disabled):not([data-disabled]):hover';
  // Note: Mantine omits data-variant on the default (filled) button, so the
  // filled rules must also match buttons with NO data-variant attribute.
  const filled = '.mantine-Button-root[data-variant="filled"],.mantine-Button-root:not([data-variant])';
  const buttonCss = `
    ${filled}{background-color:${bc};color:${readableText(bc)};}
    .mantine-Button-root[data-variant="filled"]${hov},.mantine-Button-root:not([data-variant])${hov}{background-color:${bh};}
    .mantine-Button-root[data-variant="light"]{background-color:${hexToRgba(bc, 0.12)};color:${bc};}
    .mantine-Button-root[data-variant="light"]${hov}{background-color:${hexToRgba(bh, 0.2)};}
    .mantine-Button-root[data-variant="outline"]{color:${bc};border-color:${bc};}
    .mantine-Button-root[data-variant="outline"]${hov}{background-color:${hexToRgba(bh, 0.1)};}
    .mantine-Button-root[data-variant="subtle"]{color:${bc};}
    .mantine-Button-root[data-variant="subtle"]${hov}{background-color:${hexToRgba(bh, 0.12)};}
    .mantine-Button-root[data-variant="default"]{color:${bc};border-color:${hexToRgba(bc, 0.5)};}
    .mantine-Button-root[data-variant="default"]${hov}{background-color:${hexToRgba(bh, 0.08)};border-color:${bc};}
  `;

  const isActive = (to: string) =>
    to === '/' ? location.pathname === '/' : location.pathname === to || location.pathname.startsWith(to + '/');
  const linkStyles = (active: boolean, indent = false) => ({
    root: {
      backgroundColor: active ? s.accentColor : 'transparent',
      borderRadius: 8,
      marginBottom: 2,
      paddingLeft: indent ? 28 : undefined,
    },
    label: { color: active ? accentText : menuText, fontWeight: active ? 600 : 400 },
    section: { color: active ? accentText : menuText },
  });

  return (
    <>
      <style>{buttonCss}</style>
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 240, breakpoint: 'md', collapsed: { mobile: !navOpened } }}
      padding="md"
      styles={{ main: { backgroundColor: s.bgColor, minWidth: 0, overflowX: 'clip' } }}
    >
      <AppShell.Header style={{ backgroundColor: s.menuColor, borderColor: 'rgba(0,0,0,0.1)' }}>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="xs" wrap="nowrap">
            <Burger opened={navOpened} onClick={toggleNav} hiddenFrom="md" size="sm" color={menuText} aria-label={navOpened ? 'Fechar menu' : 'Abrir menu'} />
            {logo && <Image src={logo} alt="logo" h={44} w="auto" fit="contain" />}
            <Text fw={700} size="lg" c={menuText}>
              Movni Cockpit
            </Text>
            <Badge variant="light" color="gray" visibleFrom="sm">
              Financeiro
            </Badge>
          </Group>
          <Tooltip label="Sair (desconectar do banco)">
            <ActionIcon
              variant="subtle"
              size="lg"
              onClick={() => logout.mutate()}
              loading={logout.isPending}
              style={{ color: menuText }}
              aria-label="Sair"
            >
              <IconLogout size={20} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="xs" style={{ backgroundColor: s.menuColor, borderColor: 'rgba(0,0,0,0.1)' }}>
        {NAV.map((item) => {
          if (item.children) {
            const groupActive = item.children.some((ch) => isActive(ch.to));
            return (
              <div key={item.label}>
                <NavLink
                  component={RouterNavLink}
                  to={item.to!}
                  label={item.label}
                  leftSection={<item.icon size={18} />}
                  active={groupActive}
                  styles={linkStyles(groupActive)}
                />
                {groupActive &&
                  item.children.map((ch) => {
                    const a = isActive(ch.to);
                    return (
                      <NavLink
                        key={ch.to}
                        component={RouterNavLink}
                        to={ch.to}
                        label={ch.label}
                        leftSection={<ch.icon size={16} />}
                        active={a}
                        styles={linkStyles(a, true)}
                      />
                    );
                  })}
              </div>
            );
          }
          const a = isActive(item.to!);
          return (
            <NavLink
              key={item.to}
              component={RouterNavLink}
              to={item.to!}
              label={item.label}
              leftSection={<item.icon size={18} />}
              active={a}
              styles={linkStyles(a)}
            />
          );
        })}
      </AppShell.Navbar>

      <AppShell.Main>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/customers" element={<Customers />} />
          <Route path="/customers/:id" element={<CustomerDetail />} />
          <Route path="/services" element={<Services />} />
          <Route path="/payments" element={<Payments />} />
          <Route path="/contracts" element={<Contracts />} />
          <Route path="/contracts/:id" element={<ContractDetail />} />
          <Route path="/bank" element={<BankImport />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/templates" element={<Templates />} />
          <Route path="/categories" element={<Categories />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </AppShell.Main>
    </AppShell>
    </>
  );
}
