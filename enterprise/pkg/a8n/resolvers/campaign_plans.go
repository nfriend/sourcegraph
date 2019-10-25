package resolvers

import (
	"context"
	"io"
	"strings"

	"github.com/sourcegraph/go-diff/diff"
	"github.com/sourcegraph/sourcegraph/cmd/frontend/graphqlbackend"
	ee "github.com/sourcegraph/sourcegraph/enterprise/pkg/a8n"
	"github.com/sourcegraph/sourcegraph/internal/a8n"
	"github.com/sourcegraph/sourcegraph/internal/api"
)

type campaignPlanResolver struct {
	store   *ee.Store
	campaignPlan *a8n.CampaignPlan
}

func (r *campaignPlanResolver) Spec() string { return r.campaignPlan.CampaignPlanSpec }
func (r *campaignPlanResolver) Arguments() []graphqlbackend.CampaignPlanArgResolver {
	resolvers := make([]graphqlbackend.CampaignPlanArgResolver, 0, len(r.campaignPlan.Arguments))
	for n, v := range r.campaignPlan.Arguments {
		resolvers = append(resolvers, campaignPlanArgResolver{name: n, value: v})
	}
	return resolvers
}
func (r *campaignPlanResolver) CreatedAt() graphqlbackend.DateTime {
	return graphqlbackend.DateTime{Time: r.campaignPlan.CreatedAt}
}
func (r *campaignPlanResolver) UpdatedAt() graphqlbackend.DateTime {
	return graphqlbackend.DateTime{Time: r.campaignPlan.UpdatedAt}
}

func (r *campaignPlanResolver) Jobs(ctx context.Context) ([]graphqlbackend.CampaignJobResolver, error) {
	opts := ee.ListCampaignJobsOpts{Limit: 50000, CampaignPlanID: r.campaignPlan.ID}
	jobs, _, err := r.store.ListCampaignJobs(ctx, opts)
	if err != nil {
		return nil, err
	}

	resolvers := make([]graphqlbackend.CampaignJobResolver, len(jobs))
	for i, j := range jobs {
		resolvers[i] = &campaignJobResolver{
			store:      r.store,
			campaignPlan:    r.campaignPlan,
			campaignJob: j,
		}
	}

	return resolvers, nil
}

type campaignPlanArgResolver struct{ name, value string }

func (r campaignPlanArgResolver) Name() string  { return r.name }
func (r campaignPlanArgResolver) Value() string { return r.value }

type campaignJobResolver struct {
	store      *ee.Store
	campaignPlan    *a8n.CampaignPlan
	campaignJob *a8n.CampaignJob
}

func (r *campaignJobResolver) CampaignPlan(context.Context) (graphqlbackend.CampaignPlanResolver, error) {
	return &campaignPlanResolver{}, nil
}

func (r *campaignJobResolver) Repo(ctx context.Context) (*graphqlbackend.RepositoryResolver, error) {
	return graphqlbackend.RepositoryByIDInt32(ctx, api.RepoID(r.campaignJob.RepoID))
}

func (r *campaignJobResolver) Revision() graphqlbackend.GitObjectID {
	return graphqlbackend.GitObjectID(string(r.campaignJob.Rev))
}

func (r *campaignJobResolver) Diff() *string {
	if r.campaignJob.Diff == "" {
		return nil
	}

	var fileDiffs []*diff.FileDiff
	dr := diff.NewMultiFileDiffReader(strings.NewReader(bogusDiff))
	for {
		fileDiff, err := dr.ReadFile()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil

		}
		fileDiffs = append(fileDiffs, fileDiff)
	}

	b, _ := diff.PrintMultiFileDiff(fileDiffs)
	diff := string(b)
	return &diff
}

func (r *campaignJobResolver) StartedAt() graphqlbackend.DateTime {
	return graphqlbackend.DateTime{Time: r.campaignJob.StartedAt}
}
func (r *campaignJobResolver) FinishedAt() graphqlbackend.DateTime {
	return graphqlbackend.DateTime{Time: r.campaignJob.FinishedAt}
}

func (r *campaignJobResolver) Error() *string {
	if r.campaignJob.Error != "" {
		return &r.campaignJob.Error
	}
	return nil
}
