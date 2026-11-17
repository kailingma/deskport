// Machine access and a screen session's own permissions are independent.
export const canEdit = (machine) => machine.access === 'edit';

export function screenPermissionsFor(machine, session) {
  const control = canEdit(machine) && session.control;
  return { ...session, control: Boolean(control), clipboard: Boolean(control && session.clipboard) };
}

export function grantFor(person, id, all = '*') {
  if (person.machines.includes(all) || person.machines.includes(id)) return 'edit';
  if (person.readMachines.includes(all) || person.readMachines.includes(id)) return 'read';
  return null;
}

/** The two checkboxes choose one level, or neither; Edit already includes Read. */
export function changeGrant(person, id, level, checked, all = '*') {
  let machines = [...person.machines];
  let readMachines = [...person.readMachines];
  if (id === all) {
    if (level === 'edit') {
      machines = checked ? [all] : [];
      if (checked) readMachines = [];
    } else {
      readMachines = checked ? [all] : readMachines.filter((m) => m !== all);
      if (checked && machines.includes(all)) machines = [];
    }
  } else if (!machines.includes(all)) {
    const key = level === 'edit' ? 'machines' : 'readMachines';
    machines = machines.filter((m) => m !== id);
    readMachines = readMachines.filter((m) => m !== id);
    if (checked) {
      if (key === 'machines') machines.push(id);
      else if (!readMachines.includes(all)) readMachines.push(id);
    }
  }
  return { machines: machines.sort(), readMachines: readMachines.sort(), addMachines: person.addMachines };
}
