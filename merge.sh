#!/usr/bin/env bash

set -e

BRANCHES=`cat branches.txt`
MAIN_BRANCH=`git branch --list master main | head -n 1 | col2`

for BRANCH in $BRANCHES; do
    echo Merging $BRANCH...

    WORKTREE=$(git worktree list | grep "$BRANCH" | col1)
    if [ "$WORKTREE" != "" ]; then
        git worktree remove "$WORKTREE"
    fi

    git checkout $BRANCH
    git rebase $MAIN_BRANCH
    git checkout $MAIN_BRANCH
    git merge --no-ff --no-edit $BRANCH
    git branch -D $BRANCH
done

set +e

