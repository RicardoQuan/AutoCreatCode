(() => {
  'use strict';

  const host = typeof window !== 'undefined' ? window : globalThis;

  async function parseFiles(files, machineName = '') {
    const selected = Array.from(files || []);
    if (!selected.length) throw new Error('请选择硬件 `.cs` 文件。');
    if (!host.EquipmentFlowCSharpCatalog) throw new Error('C# 元数据解析器尚未加载。');
    const parsedFiles = [];
    for (const file of selected) {
      if (!String(file.name || '').toLowerCase().endsWith('.cs'))
        throw new Error(`硬件库只接受 .cs 文件：${file.name || '未命名文件'}。`);
      parsedFiles.push(host.EquipmentFlowCSharpCatalog.parseSource(await file.text(), file.name));
    }
    const resources = [];
    const slots = [];
    const factories = [];
    parsedFiles.forEach(file => {
      (file.factories || []).forEach(factory => factories.push({
        ...factory,
        MachineName: factory.MachineName || machineName || '',
        InstanceIds: [...factory.InstanceIds],
      }));
      file.enums.forEach(enumType => enumType.members.forEach((member, index) => {
        const resourceId = `${enumType.name}.${member.name}`;
        resources.push({
          ResourceId: resourceId,
          ResourceKey: `${file.fileName}::${resourceId}`,
          ResourceType: enumType.resourceType,
          Name: member.name,
          GroupName: enumType.name,
          Index: member.value,
          Value: member.value,
          MachineName: machineName || '',
          SourceFile: file.fileName,
          SourceLine: member.line,
          Enabled: true,
        });
      }));
      file.classes.forEach(classType => classType.hardwareSlots.forEach(slot => {
        slots.push({
          ...slot,
          SlotKey: `${file.fileName}::${slot.SlotId}`,
          MachineName: machineName || '',
          SourceFile: file.fileName,
          Namespace: classType.namespace,
          BoundResourceId: '',
          BoundResourceKey: '',
        });
      }));
    });
    const resourceKeys = new Set();
    resources.forEach(resource => {
      if (resourceKeys.has(resource.ResourceKey)) throw new Error(`资源 ${resource.ResourceId} 在 ${resource.SourceFile} 中重复。`);
      resourceKeys.add(resource.ResourceKey);
    });
    const slotKeys = new Set();
    slots.forEach(slot => {
      if (slotKeys.has(slot.SlotKey)) throw new Error(`硬件槽位 ${slot.SlotId} 在 ${slot.SourceFile} 中重复。`);
      slotKeys.add(slot.SlotKey);
    });
    const factoryKeys = new Set();
    factories.forEach(factory => {
      const key = JSON.stringify([factory.FactoryId, factory.MachineName, factory.StationId]);
      if (factoryKeys.has(key)) throw new Error(`吸嘴工厂 ${factory.FactoryId} 与机种/工站作用域重复。`);
      factoryKeys.add(key);
    });
    return { files: parsedFiles, resources, slots, factories, diagnostics: parsedFiles.flatMap(file => file.diagnostics || []) };
  }

  function canBind(slot, resource) {
    return Boolean(slot && resource && slot.ResourceType === resource.ResourceType);
  }

  function bindResourceToSlot(slots, resources, slotIdOrKey, resourceIdOrKey) {
    const currentSlots = Array.from(slots || []);
    const slot = currentSlots.find(item => item.SlotKey === slotIdOrKey || item.SlotId === slotIdOrKey);
    if (!slot) throw new Error(`未找到硬件槽位 ${slotIdOrKey}。`);
    const resource = Array.from(resources || []).find(item => item.ResourceKey === resourceIdOrKey || item.ResourceId === resourceIdOrKey);
    if (!resource) throw new Error(`未找到硬件资源 ${resourceIdOrKey}。`);
    if (!canBind(slot, resource))
      throw new Error(`硬件类型不匹配：槽位 ${slot.SlotId} 要求 ${slot.ResourceType}，资源 ${resource.ResourceId} 属于 ${resource.ResourceType}。`);
    return currentSlots.map(item => (item.SlotKey || item.SlotId) === (slot.SlotKey || slot.SlotId)
      ? { ...item, BoundResourceId: resource.ResourceId, BoundResourceKey: resource.ResourceKey || resource.ResourceId }
      : { ...item });
  }

  function unbindResource(slots, slotIdOrKey) {
    const currentSlots = Array.from(slots || []);
    if (!currentSlots.some(item => item.SlotKey === slotIdOrKey || item.SlotId === slotIdOrKey))
      throw new Error(`未找到硬件槽位 ${slotIdOrKey}。`);
    return currentSlots.map(item => item.SlotKey === slotIdOrKey || item.SlotId === slotIdOrKey
      ? { ...item, BoundResourceId: '', BoundResourceKey: '' }
      : { ...item });
  }

  function createBindings(slots) {
    return Array.from(slots || []).filter(slot => slot.BoundResourceId).map(slot => ({
      MachineName: slot.MachineName || '',
      SlotId: slot.SlotId,
      SlotKey: slot.SlotKey || slot.SlotId,
      ResourceId: slot.BoundResourceId,
      ResourceKey: slot.BoundResourceKey || slot.BoundResourceId,
      ResourceType: slot.ResourceType,
      SourceFile: slot.SourceFile || '',
    }));
  }

  const api = { parseFiles, canBind, bindResourceToSlot, unbindResource, createBindings };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.EquipmentFlowHardwareLibrary = api;
})();
