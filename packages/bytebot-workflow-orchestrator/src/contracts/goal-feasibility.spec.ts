import { ExecutionSurface } from '@prisma/client';
import { inferGoalFeasibility } from './goal-feasibility';

describe('inferGoalFeasibility', () => {
  it('does not classify common programming "return" text as travel-shopping', () => {
    expect(inferGoalFeasibility('Return the hex digest of the file')).toBeNull();
    expect(inferGoalFeasibility('Return 0 if the value is missing')).toBeNull();
  });

  it('does not misclassify "department" as a travel "depart" signal', () => {
    expect(inferGoalFeasibility('Department budget review for Q1')).toBeNull();
    expect(inferGoalFeasibility('departments and returns report')).toBeNull();
  });

  it('classifies depart+return+date as travel-shopping', () => {
    expect(inferGoalFeasibility('Depart 2/1 and return 2/7')).toEqual({
      requiredSurface: ExecutionSurface.DESKTOP,
      reason: 'travel-shopping(keyword:depart+return+date)',
    });
  });
});

