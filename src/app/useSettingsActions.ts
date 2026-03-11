import { useCallback, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";

import * as api from "../api";
import { LANGUAGE_USER_SET_STORAGE_KEY } from "../i18n";
import type { Agent, CliStatusMap, CompanySettings, Department, Task } from "../types";
import { mergeSettingsWithDefaults, scrubSettingsSecretsForClient, syncClientLanguage } from "./utils";
import { shouldIncludeSeedAgents } from "./useAppActionShared";

interface UseSettingsActionsParams {
  settings: CompanySettings;
  setSettings: Dispatch<SetStateAction<CompanySettings>>;
  setCliStatus: Dispatch<SetStateAction<CliStatusMap | null>>;
  setAgents: Dispatch<SetStateAction<Agent[]>>;
  setDepartments: Dispatch<SetStateAction<Department[]>>;
  setTasks: Dispatch<SetStateAction<Task[]>>;
}

export function useSettingsActions({
  settings,
  setSettings,
  setCliStatus,
  setAgents,
  setDepartments,
  setTasks,
}: UseSettingsActionsParams) {
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const settingsSaveRequestSeqRef = useRef(0);

  const handleSaveSettings = useCallback(
    async (nextInput: CompanySettings) => {
      const previousSettings = settings;
      const nextSettings = mergeSettingsWithDefaults(nextInput);
      const nextSettingsForClient = scrubSettingsSecretsForClient(nextSettings);
      const autoUpdateChanged = Boolean(nextSettings.autoUpdateEnabled) !== Boolean(settings.autoUpdateEnabled);
      const saveRequestSeq = (settingsSaveRequestSeqRef.current += 1);
      const attemptedSnapshot = JSON.stringify(nextSettingsForClient);
      settingsRef.current = nextSettingsForClient;
      setSettings(nextSettingsForClient);
      syncClientLanguage(nextSettingsForClient.language);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(LANGUAGE_USER_SET_STORAGE_KEY, "1");
      }
      try {
        await api.saveSettings(nextSettings);
        if (autoUpdateChanged) {
          try {
            await api.setAutoUpdateEnabled(Boolean(nextSettings.autoUpdateEnabled));
          } catch (syncErr) {
            console.error("Auto update runtime sync failed:", syncErr);
          }
        }
      } catch (error) {
        const isLatestRequest = settingsSaveRequestSeqRef.current === saveRequestSeq;
        const currentSnapshot = JSON.stringify(settingsRef.current);
        if (isLatestRequest && currentSnapshot === attemptedSnapshot) {
          setSettings(previousSettings);
          syncClientLanguage(previousSettings.language);
        }
        console.error("Save settings failed:", error);
      }
    },
    [settings, setSettings],
  );

  const handleDismissAutoUpdateNotice = useCallback(async () => {
    if (!settings.autoUpdateNoticePending) return;
    setSettings((prev) => ({ ...prev, autoUpdateNoticePending: false }));
    try {
      await api.saveSettingsPatch({ autoUpdateNoticePending: false });
    } catch (error) {
      console.error("Failed to persist auto-update notice dismissal:", error);
    }
  }, [settings.autoUpdateNoticePending, setSettings]);

  const handleAgentsChange = useCallback(() => {
    const includeSeedAgents = shouldIncludeSeedAgents(settings);
    api.getAgents({ includeSeed: includeSeedAgents }).then(setAgents).catch(console.error);
    api
      .getDepartments({ workflowPackKey: settings.officeWorkflowPack ?? "development" })
      .then(setDepartments)
      .catch(console.error);
    api.getTasks().then(setTasks).catch(console.error);
  }, [setAgents, setDepartments, setTasks, settings]);

  const handleRefreshCli = useCallback(async () => {
    const status = await api.getCliStatus(true);
    setCliStatus(status);
  }, [setCliStatus]);

  return {
    handleSaveSettings,
    handleDismissAutoUpdateNotice,
    handleAgentsChange,
    handleRefreshCli,
  };
}
