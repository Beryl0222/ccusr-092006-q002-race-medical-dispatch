import assert from "node:assert/strict";
import test from "node:test";
import {
  activeRegulationAt,
  credentialValid,
  deviceReady,
  etaMinutes,
  HealthVault,
  km,
  publicView,
  teamQualifies,
} from "../src/domain.js";

test("规范按生效日期取版本，版本切换边界正确", () => {
  const regs = [
    { version: "old", effective_from: "2024-01-01T00:00:00+08:00", effective_to: "2026-09-01T00:00:00+08:00" },
    { version: "new", effective_from: "2026-09-01T00:00:00+08:00", effective_to: null },
  ];
  assert.equal(activeRegulationAt(regs, "2026-08-31T23:59:00+08:00").version, "old");
  assert.equal(activeRegulationAt(regs, "2026-09-01T00:00:00+08:00").version, "new");
  assert.equal(activeRegulationAt(regs, "2026-10-04T09:00:00+08:00").version, "new");
  assert.equal(activeRegulationAt([], "2026-10-04T09:00:00+08:00"), null);
});

test("证照在有效期边界内外判定", () => {
  const cred = { issued: "2025-01-01T00:00:00+08:00", expires: "2027-01-01T00:00:00+08:00" };
  assert.equal(credentialValid(cred, "2026-10-04T09:00:00+08:00"), true);
  assert.equal(credentialValid(cred, "2024-12-31T00:00:00+08:00"), false);
  assert.equal(credentialValid(cred, "2027-01-01T00:00:00+08:00"), false);
});

test("队伍资质等级与全部证照同时有效才算合格", () => {
  const team = {
    qual_level: "first_aid_cert",
    credentials: [{ issued: "2025-01-01T00:00:00+08:00", expires: "2028-01-01T00:00:00+08:00" }],
  };
  const at = "2026-10-04T09:00:00+08:00";
  assert.equal(teamQualifies(team, "first_aid_cert", at), true);
  assert.equal(teamQualifies(team, "emt", at), false);
  const expired = { qual_level: "emt", credentials: [{ issued: "2023-01-01T00:00:00+08:00", expires: "2024-01-01T00:00:00+08:00" }] };
  assert.equal(teamQualifies(expired, "emt", at), false);
});

test("AED 状态、电池与电极片都有效才就绪", () => {
  const at = "2026-10-04T09:00:00+08:00";
  const good = { kind: "AED", status: "ready", battery_expires: "2027-01-01T00:00:00+08:00", pad_expires: "2027-01-01T00:00:00+08:00" };
  assert.equal(deviceReady(good, at), true);
  assert.equal(deviceReady({ ...good, status: "fault" }, at), false);
  assert.equal(deviceReady({ ...good, pad_expires: "2025-01-01T00:00:00+08:00" }, at), false);
});

test("球面距离与 ETA 为单调估计", () => {
  const a = [118.1, 24.46];
  const b = [118.114, 24.466];
  const d = km(a, b);
  assert.ok(d > 1.4 && d < 1.7, `距离异常 ${d}`);
  assert.equal(etaMinutes(a, b, 30), Math.ceil((d / 30) * 60));
});

test("公开视图脱敏个人标识与健康字段，保留岗位所需信息", () => {
  const view = publicView({
    team_id: "T1",
    qual_level: "emt",
    captain: { name: "张某", phone: "13900000000", credential_number: "R-1", conditions: ["高血压"] },
    medications: ["阿司匹林"],
  });
  assert.equal(view.team_id, "T1");
  assert.equal(view.qual_level, "emt");
  assert.equal(view.captain.phone, "***");
  assert.equal(view.captain.credential_number, "***");
  assert.deepEqual(view.captain.conditions, []);
  assert.deepEqual(view.medications, []);
});

test("健康库仅 medical_officer + phi 可读，读取（含拒绝）留痕", () => {
  const vault = new HealthVault([{ bib: "X1", conditions: ["虚构病症"] }]);
  assert.throws(() => vault.read("t", "volunteer", []), (e) => e.code === "PHI_DENIED");
  assert.throws(() => vault.read("t", "medical_officer", []), (e) => e.code === "PHI_DENIED");
  const rows = vault.read("t", "medical_officer", ["phi"]);
  assert.equal(rows.length, 1);
  assert.equal(vault.accessLog.length, 3);
  assert.deepEqual(vault.accessLog.map((x) => x.granted), [false, false, true]);
  assert.ok(vault.sensitiveTokens().includes("虚构病症"));
});
