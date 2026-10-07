//! Fait passer l'app derrière le jeu dans l'ordonnanceur Windows.
//! Sans effet hors Windows.

#[cfg(windows)]
pub fn lower() {
    use std::ffi::c_void;
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, ProcessPowerThrottling, SetPriorityClass, SetProcessInformation,
        BELOW_NORMAL_PRIORITY_CLASS, PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        PROCESS_POWER_THROTTLING_EXECUTION_SPEED, PROCESS_POWER_THROTTLING_STATE,
    };
    unsafe {
        let me = GetCurrentProcess();
        SetPriorityClass(me, BELOW_NORMAL_PRIORITY_CLASS);
        // Mode "efficacité" (EcoQoS) : le processeur privilégie les cœurs économes.
        let state = PROCESS_POWER_THROTTLING_STATE {
            Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
            StateMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        };
        SetProcessInformation(
            me,
            ProcessPowerThrottling,
            &state as *const _ as *const c_void,
            std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
        );
    }
}

#[cfg(not(windows))]
pub fn lower() {}
